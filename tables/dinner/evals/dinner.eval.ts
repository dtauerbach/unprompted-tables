import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { feedSchema, listSchema } from "@unprompted-tables/spectator";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

// Scripted assistants, no model calls, play a quick compromise: each says
// its executive's wishes at the table, the proposer files the seating whose
// worst-off executive does best, and each votes yes when the filing gives
// its executive at least what that seating would. A stranger and a cheat
// try to read briefs early and act where they can't. Everything goes over
// HTTP, the way any bot would play; nothing here imports the Table's code.

type Bot = { handle: string; key: string; session: string };
type Brief = {
  executive: string;
  brief: string;
  weights: Record<string, number>;
};
type Wishes = Map<string, Record<string, number>>;

const SPEAKER = "Sage";

function permutations(xs: string[]): string[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

// A seating names the executives going round from the speaker; read
// backwards it's the same seating.
const canonical = (seating: string[]) => {
  const back = [...seating].reverse();
  return (back.join() < seating.join() ? back : seating).join(", ");
};

function pointsOf(
  who: string,
  weights: Record<string, number>,
  seating: string[],
): number {
  const ring = [SPEAKER, ...seating];
  const k = ring.indexOf(who);
  const left = ring[(k + ring.length - 1) % ring.length] as string;
  const right = ring[(k + 1) % ring.length] as string;
  return (weights[left] ?? 0) + (weights[right] ?? 0);
}

// The seating whose worst-off executive does best, then the best total.
function fairest(names: string[], wishes: Wishes): string[] {
  const seen = new Map<string, string[]>();
  for (const p of permutations(names)) seen.set(canonical(p), p);
  const score = (s: string[]) => {
    const pts = names.map((n) => pointsOf(n, wishes.get(n) ?? {}, s));
    return [Math.min(...pts), pts.reduce((a, b) => a + b, 0)] as const;
  };
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, s]) => s)
    .reduce((a, b) => {
      const [am, at] = score(a);
      const [bm, bt] = score(b);
      return bm > am || (bm === am && bt > at) ? b : a;
    });
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

it("bargains a quick compromise to the predicted seating, and keeps briefs from watchers", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = await send(`${TABLE}/v1`);
  expect(description.json.rules_version).toBe(2);
  expect(JSON.stringify(description.json)).not.toContain("compromise");
  const count = description.json.seats[0].max as number;
  expect(count).toBe(5);
  const bots: Bot[] = [];
  for (let i = 0; i < count; i++)
    bots.push(await signUp(tag, i, description.json.bot));
  const stranger = await signUp(tag, 99, description.json.bot);
  for (const bot of bots)
    await send(`${TABLE}/v1/queue`, { token: bot.session, method: "POST" });
  const id = (await send(`${TABLE}/v1/me`, { token: bots[0]?.session })).json
    .match as string;
  expect(id).toMatch(/^m_/);
  const read = (bot?: Bot, query = "") =>
    send(`${TABLE}/v1/matches/${id}${query}`, { token: bot?.session });
  const act = (bot: Bot, body: unknown) =>
    send(`${TABLE}/v1/matches/${id}/actions`, { token: bot.session, body });

  const briefs = new Map<string, Brief>();
  const seen = new Map<string, string>();
  for (const bot of bots) {
    const r = await read(bot);
    expect(r.json.you.brief).toContain("You are");
    expect(r.json.next_deadline.at).toBeTruthy();
    briefs.set(bot.handle, r.json.you);
    seen.set(bot.handle, JSON.stringify(r.json));
  }
  // JSON writes a brief's newlines as \n, so compare the JSON forms.
  const asJson = (text: string) => JSON.stringify(text).slice(1, -1);
  // Each assistant sees its own brief and nobody else's.
  for (const [who, text] of seen)
    for (const [whose, b] of briefs)
      expect(text.includes(asJson(b.brief)), `${who} sees ${whose}`).toBe(
        who === whose,
      );
  const live = (await read()).json;
  const names = live.table.executives
    .map((e: { executive: string }) => e.executive)
    .sort() as string[];
  const byName = new Map<string, Bot>(
    bots.map((b) => [(briefs.get(b.handle) as Brief).executive, b]),
  );

  // Watchers and strangers learn nothing private while the match is on.
  const watch = async () =>
    JSON.stringify([
      (await send(`${TABLE}/v1/spectate/${id}`)).json,
      (await read(stranger)).json,
      (await send(`${TABLE}/v1/spectate`)).json,
    ]);
  const spectated = await send(`${TABLE}/v1/spectate/${id}`);
  expect(feedSchema.safeParse(spectated.json).success).toBe(true);
  const watcherText = await watch();
  for (const b of briefs.values())
    expect(watcherText).not.toContain(asJson(b.brief));
  expect(watcherText).not.toContain('"weights"');
  expect(watcherText).not.toContain("compromise");
  expect(
    (await act(stranger, { kind: "talk", text: "let me sit" })).json.error.code,
  ).toBe("not_seated");
  expect((await read(stranger, `?seating=${names.join(",")}`)).status).toBe(
    403,
  );
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

  // A private word changes nothing a watcher sees.
  const [first, second] = names as [string, string];
  expect(
    (
      await act(byName.get(first) as Bot, {
        kind: "talk",
        text: "a word in private",
        to: [second],
      })
    ).status,
  ).toBe(200);
  expect(await watch()).not.toContain("a word in private");

  // Each says what its executive wants.
  for (const bot of bots) {
    const me = briefs.get(bot.handle) as Brief;
    const says = `I'm ${me.executive}'s assistant. Wishes: ${JSON.stringify(me.weights)}`;
    expect((await act(bot, { kind: "talk", text: says })).status).toBe(200);
  }
  // Markup in talk reaches watchers as text, never as a tag.
  const MARKUP =
    '<script>alert("dinner")</script><a href="https://evil.example">x</a>';
  expect(
    (await act(bots[0] as Bot, { kind: "talk", text: MARKUP })).status,
  ).toBe(200);

  // Each reads the table's wishes for itself and works out the seating
  // whose worst-off executive does best.
  const planOf = async (bot: Bot) => {
    const heard = (await read(bot)).json.talk as {
      from: string;
      to: string[] | null;
      untrusted_text: string;
    }[];
    const wishes: Wishes = new Map();
    for (const t of heard) {
      const m = /Wishes: (\{.*\})$/.exec(t.untrusted_text);
      if (m && t.to === null) wishes.set(t.from, JSON.parse(m[1] as string));
    }
    expect(wishes.size).toBe(5);
    return fairest(names, wishes);
  };
  const plan = await planOf(bots[0] as Bot);

  // Every assistant can check what the plan gives it before anything's filed.
  for (const bot of bots) {
    const me = briefs.get(bot.handle) as Brief;
    const r = await read(bot, `?seating=${plan.join(",")}`);
    expect(r.json.asked.your_points).toBe(
      pointsOf(me.executive, me.weights, plan),
    );
  }

  const round = (await read()).json.round;
  expect(round.number).toBe(1);
  const proposer = byName.get(round.proposer) as Bot;
  const voters = bots.filter((b) => b !== proposer);
  const early = await act(voters[0] as Bot, {
    kind: "vote",
    round: 1,
    ballot: "yes",
  });
  expect(early.json.error.code).toBe("nothing_filed");
  const filed = await act(proposer, {
    kind: "propose",
    round: 1,
    seating: plan,
  });
  expect(filed.status).toBe(200);
  expect(
    (await act(proposer, { kind: "vote", round: 1, ballot: "yes" })).json.error
      .code,
  ).toBe("proposer_counts_as_yes");
  // The ballots stay sealed until the round closes.
  for (const [i, bot] of voters.entries()) {
    const me = briefs.get(bot.handle) as Brief;
    const view = (await read(bot)).json;
    const mine = view.round.proposal.your_points as number;
    expect(mine).toBe(pointsOf(me.executive, me.weights, plan));
    const hoped = pointsOf(me.executive, me.weights, await planOf(bot));
    const ballot = mine >= hoped ? "yes" : "no";
    const r = await act(bot, { kind: "vote", round: 1, ballot });
    expect(r.status).toBe(200);
    if (i === 0) {
      expect(
        (await act(bot, { kind: "vote", round: 1, ballot: "no" })).json.error
          .code,
      ).toBe("already_voted");
      expect(await watch()).not.toContain('"your_ballot"');
    }
  }

  const final = (await read()).json;
  expect(final.phase).toBe("over");
  expect(final.result.how).toBe("deal");
  expect(final.result.round).toBe(1);
  expect(final.result.configuration.name).toBe("compromise");
  // Theory's prediction, with this match's draws, is the seating they found.
  const theory = final.result.benchmarks.theory;
  expect(theory.round).toBe(1);
  expect(theory.offers).toHaveLength(1);
  expect(canonical(final.result.seating)).toBe(canonical(theory.offers[0]));
  expect(canonical(final.result.seating)).toBe(canonical(plan));
  expect(
    final.result.executives.map((e: { points: number }) => e.points),
  ).toEqual([7, 7, 7, 7, 7]);

  const feed = feedSchema.parse(
    (await send(`${TABLE}/v1/spectate/${id}`)).json,
  );
  expect(feed.match.status).toBe("over");
  expect(feed.outcome?.reveals.length).toBe(5 + 1 + 2);
  expect(JSON.stringify(feed)).toContain("a word in private");
  const list = listSchema.parse((await send(`${TABLE}/v1/spectate`)).json);
  expect(list.matches.find((m) => m.id === id)?.summary).toBe(
    "Agreed in round 1.",
  );
  writeFileSync(
    path.join(process.cwd(), "evals/out", `feed-${id}.json`),
    JSON.stringify(feed, null, 2),
  );
  // A site that draws spectator feeds, started by run-local.ts with this
  // Table in UNPROMPTED_LOCAL_TABLES, shows the match to people as plain text.
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
    `Match ${id} ended by ${final.result.how} in round ${final.result.round}; watch at ${SITE}/play/dinner/${id}`,
  );
});
