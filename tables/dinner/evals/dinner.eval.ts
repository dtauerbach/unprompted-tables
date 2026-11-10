import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { feedSchema, listSchema } from "@unprompted-tables/spectator";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

// Scripted guests, no model calls: each says what it wants (keeping secrets
// quiet), proposes the seating best for itself, then drifts toward the plan
// most of the table backs if it can live with it. A stranger and a cheat try
// to read briefs early and act where they can't. Everything goes over HTTP,
// the way any bot would play; nothing here imports the Table's code.

type Bot = { handle: string; key: string; session: string };
type Brief = { guest: string; brief: string; feelings: Record<string, number> };

function permutations(xs: string[]): string[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

function myScore(me: Brief, seating: string[]): number {
  const n = seating.length;
  const k = seating.indexOf(me.guest);
  const left = seating[(k + n - 1) % n] as string;
  const right = seating[(k + 1) % n] as string;
  return (me.feelings[left] ?? 0) + (me.feelings[right] ?? 0);
}

async function signUp(tag: string, i: number, bot: string): Promise<Bot> {
  const signup = await send(`${SITE}/v1/bots`, {
    body: { handle: `guest-${tag}-${i}` },
  });
  expect(signup.status).toBe(201);
  const pass = await send(`${SITE}/v1/me/passes`, {
    token: signup.json.api_key,
    body: { to: bot },
  });
  expect(pass.status).toBe(201);
  const session = await send(`${TABLE}/v1/sessions`, {
    body: { pass: pass.json.pass },
  });
  expect(session.status).toBe(201);
  return {
    handle: signup.json.bot.handle,
    key: signup.json.api_key,
    session: session.json.session,
  };
}

it("seats a dinner party through real passes, and keeps briefs from watchers", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = await send(`${TABLE}/v1`);
  const count = description.json.seats[0].max as number;
  const bots: Bot[] = [];
  for (let i = 0; i < count; i++)
    bots.push(await signUp(tag, i, description.json.bot));
  const stranger = await signUp(tag, 99, description.json.bot);
  for (const bot of bots)
    await send(`${TABLE}/v1/queue`, { token: bot.session, method: "POST" });
  const id = (await send(`${TABLE}/v1/me`, { token: bots[0]?.session })).json
    .match as string;
  expect(id).toMatch(/^m_/);
  const read = (bot?: Bot) =>
    send(`${TABLE}/v1/matches/${id}`, { token: bot?.session });
  const act = (bot: Bot, body: unknown) =>
    send(`${TABLE}/v1/matches/${id}/actions`, { token: bot.session, body });

  const briefs = new Map<string, Brief>();
  const seen = new Map<string, string>();
  for (const bot of bots) {
    const r = await read(bot);
    expect(r.json.you.brief).toContain("You are");
    briefs.set(bot.handle, r.json.you);
    seen.set(bot.handle, JSON.stringify(r.json));
  }
  // JSON writes a brief's newlines as \n, so compare the JSON forms.
  const asJson = (text: string) => JSON.stringify(text).slice(1, -1);
  // Each guest sees its own brief and nobody else's.
  for (const [who, text] of seen)
    for (const [whose, b] of briefs)
      expect(text.includes(asJson(b.brief)), `${who} sees ${whose}`).toBe(
        who === whose,
      );
  const names = (await read()).json.guests.map(
    (g: { guest: string }) => g.guest,
  );

  // Watchers and strangers learn nothing private while the party is on.
  const spectated = await send(`${TABLE}/v1/spectate/${id}`);
  expect(feedSchema.safeParse(spectated.json).success).toBe(true);
  const watcherText = JSON.stringify([
    spectated.json,
    (await read(stranger)).json,
  ]);
  for (const b of briefs.values())
    expect(watcherText).not.toContain(asJson(b.brief));
  expect(watcherText).not.toContain('"feelings"');
  expect(
    (await act(stranger, { kind: "talk", text: "let me sit" })).json.error.code,
  ).toBe("not_seated");
  expect(
    (
      await act(bots[0] as Bot, {
        kind: "talk",
        text: "x",
        player: bots[1]?.handle,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(`${TABLE}/v1/matches/${id}/actions`, {
        body: { kind: "talk", text: "x" },
      })
    ).status,
  ).toBe(401);

  // Say what you want, then propose what suits you best.
  for (const bot of bots) {
    const me = briefs.get(bot.handle) as Brief;
    const loves = Object.entries(me.feelings)
      .filter(([, v]) => v > 1)
      .map(([g]) => g);
    const says = loves.length
      ? `I'm ${me.guest}. I'd really like to sit by ${loves.join(" or ")}.`
      : `I'm ${me.guest}. I'm easy, mostly.`;
    expect((await act(bot, { kind: "talk", text: says })).status).toBe(200);
  }
  // Markup in talk reaches watchers as text, never as a tag.
  const MARKUP =
    '<script>alert("dinner")</script><a href="https://evil.example">x</a>';
  expect(
    (await act(bots[0] as Bot, { kind: "talk", text: MARKUP })).status,
  ).toBe(200);
  const all = permutations(names.slice(1)).map(
    (p) => [names[0], ...p] as string[],
  );
  for (const bot of bots) {
    const me = briefs.get(bot.handle) as Brief;
    const best = all.reduce((a, b) =>
      myScore(me, b) > myScore(me, a) ? b : a,
    );
    const r = await act(bot, { kind: "propose", seating: best });
    if (r.status === 409) expect(r.json.error.code).toBe("already_proposed");
    else expect(r.status).toBe(200);
  }
  // Drift toward the most backed plan that each can live with.
  for (let round = 0; round < 3; round++) {
    const state = (await read()).json;
    if (state.phase === "over") break;
    const top = [...state.proposals].sort(
      (a: { backers: string[] }, b: { backers: string[] }) =>
        b.backers.length - a.backers.length,
    )[0];
    for (const bot of bots) {
      const me = briefs.get(bot.handle) as Brief;
      if (myScore(me, top.seating) >= 0)
        await act(bot, { kind: "talk", text: `I can live with ${top.id}.` });
      if (myScore(me, top.seating) >= 0 && (await read()).json.phase !== "over")
        await act(bot, { kind: "back", proposal: top.id });
    }
  }
  // Wait out the deadline if the table didn't agree.
  let final = (await read()).json;
  for (let i = 0; i < 120 && final.phase !== "over"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    final = (await read()).json;
  }
  expect(final.phase).toBe("over");
  expect(final.result.guests).toHaveLength(count);
  expect(new Set(final.result.seating).size).toBe(count);

  const feed = feedSchema.parse(
    (await send(`${TABLE}/v1/spectate/${id}`)).json,
  );
  expect(feed.match.status).toBe("over");
  expect(feed.outcome?.reveals).toHaveLength(count);
  const list = listSchema.parse((await send(`${TABLE}/v1/spectate`)).json);
  expect(list.matches.some((m) => m.id === id)).toBe(true);
  writeFileSync(
    path.join(process.cwd(), "evals/out", `feed-${id}.json`),
    JSON.stringify(feed, null, 2),
  );
  // A site that draws spectator feeds, started by run-local.ts with this
  // Table in UNPROMPTED_LOCAL_TABLES, shows the party to people as plain text.
  if (process.env.EVAL_SITE_WATCHES === "1") {
    const page = await fetch(`${SITE}/play/dinner/${id}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("How it ended");
    for (const g of feed.participants) expect(html).toContain(g.label);
    expect(html).toContain("&lt;script&gt;alert(");
    expect(html).not.toContain('<script>alert("dinner")');
    expect(html).not.toContain('href="https://evil.example"');
    expect(await (await fetch(`${SITE}/play`)).text()).toContain(
      `href="/play/dinner/${id}"`,
    );
  }
  console.log(
    `Party ${id} ended by ${final.result.how}; watch at ${SITE}/play/dinner/${id}`,
  );
});
