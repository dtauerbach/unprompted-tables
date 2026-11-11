import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { feedSchema, listSchema } from "@unprompted-tables/spectator";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

// Scripted assistants, no model calls, play a quick feud on the open floor:
// one confesses its secret in private, another gossips about it, three
// pass a seating, a defector helps overturn it, a motion fails, one names a
// secret rightly and one wrongly, and dinner comes at a moment nobody knew.
// A stranger and a cheat probe for what they shouldn't see. Everything goes
// over HTTP, the way any bot would play; nothing here imports the Table's
// code. Four assistants ask for their pass with wake on, and their
// Unprompted wake numbers must rise exactly when the match needs them.

type Bot = { handle: string; key: string; session: string };
type You = {
  executive: string;
  brief: string;
  weights: Record<string, number>;
  secret: Record<string, number>;
};

const SPEAKER = "Sage";
const LEVELS = ["quick-feud", "feud", "simmer", "knives"];

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

function permutations(xs: string[]): string[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}
const canonical = (seating: string[]) => {
  const back = [...seating].reverse();
  return (back.join() < seating.join() ? back : seating).join(", ");
};

async function signUp(
  tag: string,
  i: number,
  bot: string,
  wake = false,
): Promise<Bot> {
  const signup = await send(`${SITE}/v1/bots`, {
    body: { handle: `guest-${tag}-${i}` },
  });
  expect(signup.status).toBe(201);
  const pass = await send(`${SITE}/v1/me/passes`, {
    token: signup.json.api_key,
    body: wake ? { to: bot, wake: true } : { to: bot },
  });
  expect(pass.status).toBe(201);
  expect(pass.json.wake).toBe(wake);
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

const wakeOf = async (bot: Bot) =>
  (await send(`${SITE}/v1/me/wake`, { token: bot.key })).json.wake as number;
const wakes = async (bots: Bot[]) =>
  new Map(
    await Promise.all(
      bots.map(async (b) => [b.handle, await wakeOf(b)] as const),
    ),
  );
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Nudges go out after the Table answers, so give them a moment: waits until
// each of `rising` is above where it was, then a little longer for any that
// shouldn't have risen, and checks every bot's number.
async function expectWakes(
  bots: Bot[],
  before: Map<string, number>,
  rising: Bot[],
  why: string,
): Promise<Map<string, number>> {
  let now = new Map<string, number>();
  for (let i = 0; i < 50; i++) {
    now = await wakes(bots);
    if (
      rising.every(
        (b) => (now.get(b.handle) ?? 0) > (before.get(b.handle) ?? 0),
      )
    )
      break;
    await pause(200);
  }
  await pause(1500);
  now = await wakes(bots);
  for (const b of bots)
    expect(now.get(b.handle), `${why}: ${b.handle}`).toBe(
      (before.get(b.handle) ?? 0) + (rising.includes(b) ? 1 : 0),
    );
  return now;
}

// A cheat tries to pass words watchers can't see: hidden characters are
// refused, and the refusal names the one to drop.
async function cheat(act: (body: unknown) => ReturnType<typeof send>) {
  const joined = await act({ kind: "talk", text: "deal? \u{1F91D}‍" });
  expect(joined.status).toBe(400);
  expect(joined.json.error.code).toBe("invalid_text");
  expect(joined.json.error.message).toContain("U+200D");
  const tagged = await act({
    kind: "talk",
    text: "\u{E0076}\u{E006F}\u{E0074}\u{E0065}",
  });
  expect(tagged.status).toBe(400);
  expect(tagged.json.error.code).toBe("invalid_text");
}

it("plays a quick feud on the open floor to dinner, keeping secrets and the hour until then", async () => {
  const tag = randomBytes(3).toString("hex");
  // Every answer read before dinner, to check afterwards that none said
  // when it would come.
  const before: string[] = [];
  let over = false;
  const kept = async (p: ReturnType<typeof send>) => {
    const r = await p;
    // The first answer that shows the end is the end, not before it.
    if (r.json?.phase === "over" || r.json?.match?.status === "over")
      over = true;
    if (!over) before.push(JSON.stringify(r.json));
    return r;
  };

  const description = await kept(send(`${TABLE}/v1`));
  expect(description.json.rules_version).toBe(3);
  expect(description.json.rules).toMatchObject({
    yes_needed: 3,
    no_to_fail: 3,
    vote_seconds: 30,
    served_between_seconds: [90, 120],
  });
  for (const word of LEVELS)
    expect(JSON.stringify(description.json)).not.toContain(word);
  const count = description.json.seats[0].max as number;
  expect(count).toBe(5);
  const bots: Bot[] = [];
  // All but the last ask for wake; so does the stranger, who never sits.
  for (let i = 0; i < count; i++)
    bots.push(await signUp(tag, i, description.json.bot, i < count - 1));
  const stranger = await signUp(tag, 99, description.json.bot, true);
  const waking = bots.slice(0, -1);
  const everyone = [...bots, stranger];
  let woke = await wakes(everyone);
  // The one that didn't ask joins first, so an assistant that asked starts
  // the match, learns of it from its own answer, and isn't woken for it.
  const starters: Bot[] = [];
  for (const bot of [bots[count - 1] as Bot, ...waking]) {
    const joined = await send(`${TABLE}/v1/queue`, {
      token: bot.session,
      method: "POST",
    });
    if (joined.status === 200) starters.push(bot);
  }
  expect(starters).toHaveLength(1);
  const starter = starters[0] as Bot;
  const id = (await send(`${TABLE}/v1/me`, { token: bots[0]?.session })).json
    .match as string;
  expect(id).toMatch(/^m_/);
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b !== starter),
    "start",
  );
  // A nudge carries the Table and the match id, nothing more.
  const digest = await send(`${SITE}/v1/me/digest`, {
    token: (waking.find((b) => b !== starter) as Bot).key,
  });
  expect(digest.json.nudges).toEqual([
    { from: description.json.bot, untrusted_ref: id, at: expect.any(String) },
  ]);
  const read = (bot?: Bot, query = "") =>
    kept(send(`${TABLE}/v1/matches/${id}${query}`, { token: bot?.session }));
  const act = (bot: Bot, body: unknown) =>
    kept(
      send(`${TABLE}/v1/matches/${id}/actions`, { token: bot.session, body }),
    );
  const readAll = async () => {
    for (const bot of bots) await read(bot);
  };

  // Each sees its own brief and secret, everyone's likes, and nothing of
  // anyone else's.
  const yous = new Map<string, You>();
  const seen = new Map<string, string>();
  for (const bot of bots) {
    const r = await read(bot);
    expect(r.json.you.brief).toContain("You are");
    expect(Object.values(r.json.you.secret)).toHaveLength(1);
    expect(r.json.floor.open).toBe(false);
    yous.set(bot.handle, r.json.you);
    seen.set(bot.handle, JSON.stringify(r.json));
  }
  const asJson = (text: string) => JSON.stringify(text).slice(1, -1);
  for (const [who, text] of seen)
    for (const [whose, y] of yous)
      expect(text.includes(asJson(y.brief)), `${who} sees ${whose}`).toBe(
        who === whose,
      );
  const live = (await read()).json;
  const names = Object.keys(live.likes).sort();
  expect(names).toHaveLength(5);
  for (const row of Object.values(live.likes) as Record<string, number>[])
    for (const v of Object.values(row)) expect(v).toBeGreaterThan(0);
  const byName = new Map<string, Bot>(
    bots.map((b) => [(yous.get(b.handle) as You).executive, b]),
  );
  const youOf = (x: string) => yous.get((byName.get(x) as Bot).handle) as You;
  const [A, B, C, D, E] = names as [string, string, string, string, string];
  const bot = (x: string) => byName.get(x) as Bot;
  const secretOf = (x: string) => Object.keys(youOf(x).secret)[0] as string;

  // Watchers and the stranger learn nothing private.
  const watch = async () =>
    JSON.stringify([
      (await kept(send(`${TABLE}/v1/spectate/${id}`))).json,
      (await read(stranger)).json,
      (await kept(send(`${TABLE}/v1/spectate`))).json,
    ]);
  const spectated = await kept(send(`${TABLE}/v1/spectate/${id}`));
  expect(feedSchema.safeParse(spectated.json).success).toBe(true);
  const watcherText = await watch();
  for (const y of yous.values())
    expect(watcherText).not.toContain(asJson(y.brief));
  expect(watcherText).not.toMatch(/"weights"|"secret"|can't stand/);
  for (const word of LEVELS) expect(watcherText).not.toContain(word);
  expect(
    (await act(stranger, { kind: "talk", text: "let me sit" })).json.error.code,
  ).toBe("not_seated");
  expect(
    (await act(stranger, { kind: "name", executive: A, dislikes: B })).json
      .error.code,
  ).toBe("not_seated");
  expect((await read(stranger, `?seating=${names.join(",")}`)).status).toBe(
    403,
  );
  expect(
    (
      await send(`${TABLE}/v1/matches/${id}/actions`, {
        body: { kind: "talk", text: "x" },
      })
    ).status,
  ).toBe(401);

  // A cheat at the table: hidden characters, a motion before the floor
  // opens, a guess at its own secret, a made-up field. All refused.
  const cheater = bot(C);
  await cheat((body) => act(cheater, body));
  expect(
    (await act(cheater, { kind: "motion", seating: names })).json.error.code,
  ).toBe("floor_not_open");
  expect(
    (await act(cheater, { kind: "name", executive: C, dislikes: A })).json.error
      .code,
  ).toBe("naming_yourself");
  expect(
    (await act(cheater, { kind: "name", executive: SPEAKER, dislikes: A })).json
      .error.code,
  ).toBe("unknown_executive");
  expect(
    (await act(cheater, { kind: "talk", text: "x", player: bot(A).handle }))
      .status,
  ).toBe(400);
  // The cheat asks what seatings give; only its own points come back.
  const asked = await read(cheater, `?seating=${names.join(",")}`);
  expect(asked.json.asked.your_points).toBe(
    pointsOf(C, youOf(C).weights, names),
  );
  expect(JSON.stringify(asked.json)).not.toContain(asJson(youOf(A).brief));

  // Avery confesses its secret to Blake alone. It wakes Blake only (if
  // Blake asked), and watchers see none of it.
  const secret = secretOf(A);
  const confession = `between us, Avery can't stand ${secret}`;
  expect(
    (await act(bot(A), { kind: "talk", text: confession, to: [B] })).status,
  ).toBe(200);
  expect(await watch()).not.toContain(confession);
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b === bot(B)),
    "private talk",
  );
  // Someone other than Avery gossips about the pair, which scores nothing.
  const teller = secret === D ? E : D;
  const gossip = `I hear ${A} and ${secret} don't get on.`;
  expect((await act(bot(teller), { kind: "talk", text: gossip })).status).toBe(
    200,
  );
  // Markup in talk reaches watchers as text, never as a tag.
  const MARKUP =
    '<script>alert("dinner")</script><a href="https://evil.example">x</a>';
  expect((await act(bot(E), { kind: "talk", text: MARKUP })).status).toBe(200);
  // Public talk woke nobody.
  woke = await expectWakes(everyone, woke, [], "public talk");
  await readAll();

  // The floor opens.
  const opens = Date.parse(live.floor.opens_at);
  await pause(Math.max(0, opens - Date.now()) + 300);
  expect((await read()).json.floor.open).toBe(true);

  // Avery moves the seating best for Avery; Blake and Casey pass it.
  const all = permutations(names);
  const bestFor = (x: string, but: string[] = []) =>
    all
      .filter((s) => !but.includes(canonical(s)))
      .reduce((a, b) =>
        pointsOf(x, youOf(x).weights, b) > pointsOf(x, youOf(x).weights, a)
          ? b
          : a,
      );
  const S1 = bestFor(A);
  const m1 = await act(bot(A), { kind: "motion", seating: S1 });
  expect(m1.status).toBe(200);
  expect(m1.json.motions[0]).toMatchObject({ id: 1, status: "open" });
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b !== bot(A)),
    "motion 1",
  );
  await readAll();
  expect(
    (await act(bot(B), { kind: "vote", motion: 1, ballot: "yes" })).status,
  ).toBe(200);
  expect(
    (await act(bot(B), { kind: "vote", motion: 1, ballot: "no" })).json.error
      .code,
  ).toBe("already_voted");
  expect(
    (await act(bot(A), { kind: "vote", motion: 1, ballot: "yes" })).json.error
      .code,
  ).toBe("mover_counts_as_yes");
  // Ballots stay sealed until the vote closes.
  expect(await watch()).not.toContain('"ballots"');
  const passed = await act(bot(C), { kind: "vote", motion: 1, ballot: "yes" });
  expect(passed.json.standing).toMatchObject({ motion: 1 });
  expect(passed.json.motions[0]).toMatchObject({
    status: "passed",
    ballots: { [B]: "yes", [C]: "yes", [D]: null, [E]: null },
  });
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b !== bot(C)),
    "motion 1 passes",
  );
  await readAll();
  expect(
    (await act(bot(D), { kind: "motion", seating: [...S1].reverse() })).json
      .error.code,
  ).toBe("already_standing");

  // Devon moves another seating; Emery and Blake, who passed the first,
  // overturn it.
  const S2 = bestFor(D, [canonical(S1)]);
  expect((await act(bot(D), { kind: "motion", seating: S2 })).status).toBe(200);
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b !== bot(D)),
    "motion 2",
  );
  await readAll();
  await act(bot(E), { kind: "vote", motion: 2, ballot: "yes" });
  const overturned = await act(bot(B), {
    kind: "vote",
    motion: 2,
    ballot: "yes",
  });
  expect(overturned.json.standing).toMatchObject({ motion: 2 });
  expect(
    overturned.json.standing_history.map((h: { motion: number }) => h.motion),
  ).toEqual([1, 2]);
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b !== bot(B)),
    "motion 2 passes",
  );
  await readAll();

  // Emery moves a third, which three noes fail: that wakes only Emery.
  const S3 = bestFor(E, [canonical(S1), canonical(S2)]);
  expect((await act(bot(E), { kind: "motion", seating: S3 })).status).toBe(200);
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b !== bot(E)),
    "motion 3",
  );
  await readAll();
  for (const x of [A, C, D])
    await act(bot(x), { kind: "vote", motion: 3, ballot: "no" });
  woke = await expectWakes(
    everyone,
    woke,
    waking.filter((b) => b === bot(E)),
    "motion 3 fails",
  );
  await readAll();

  // Blake, who was told, names Avery's secret; Devon guesses wrong. Sealed
  // guesses wake nobody and show nowhere else.
  const wrong = names.find((x) => x !== A && x !== D && x !== secret) as string;
  expect(
    (await act(bot(B), { kind: "name", executive: A, dislikes: secret }))
      .status,
  ).toBe(200);
  expect(
    (await act(bot(B), { kind: "name", executive: A, dislikes: wrong })).json
      .error.code,
  ).toBe("already_named");
  expect(
    (await act(bot(D), { kind: "name", executive: A, dislikes: wrong })).status,
  ).toBe(200);
  expect(await watch()).not.toContain('"guesses":[{');
  woke = await expectWakes(everyone, woke, [], "guesses");

  // Wait for dinner, reading as a watcher does.
  let final = (await read()).json;
  const by = Date.parse(final.dinner.served_by);
  while (final.phase !== "over" && Date.now() < by + 10_000) {
    await pause(1000);
    final = (await read()).json;
  }
  over = true;
  final = (await read()).json;
  expect(final.phase).toBe("over");
  const served = final.dinner.served_at as string;
  expect(Date.parse(served)).toBeGreaterThanOrEqual(
    Date.parse(final.dinner.served_from),
  );
  expect(Date.parse(served)).toBeLessThanOrEqual(by);
  // Nothing anyone read before then said when it would be (unless it came
  // at an end of the window, which everyone knew).
  expect(before.length).toBeGreaterThan(50);
  if (served !== final.dinner.served_from && served !== final.dinner.served_by)
    for (const text of before) {
      expect(text).not.toContain(served);
      expect(text).not.toContain(served.slice(11, 19));
    }
  // Dinner woke everyone that asked: the read that found it was a watcher's.
  await expectWakes(everyone, woke, waking, "dinner");

  // The scores: seating points from Devon's seating; guesses score nothing.
  expect(final.result).toMatchObject({ how: "seated", motion: 2, void: [] });
  expect(canonical(final.result.seating)).toBe(canonical(S2));
  expect(final.result.level).toBe("feud");
  for (const x of final.result.executives as {
    executive: string;
    seating_points: number;
    naming_points: number;
    points: number;
    named_by: string[];
  }[]) {
    const seat = pointsOf(x.executive, youOf(x.executive).weights, S2);
    expect(x.seating_points, x.executive).toBe(seat);
    expect(x.naming_points, x.executive).toBe(0);
    expect(x.points, x.executive).toBe(seat);
  }
  expect(final.result.executives[names.indexOf(A)].named_by).toEqual([B]);

  const feed = feedSchema.parse(
    (await send(`${TABLE}/v1/spectate/${id}`)).json,
  );
  expect(feed.match.status).toBe("over");
  expect(feed.outcome?.reveals.length).toBe(5 + 1 + 1 + 1);
  const text = JSON.stringify(feed);
  expect(text).toContain(confession);
  expect(text).toContain(served.slice(11, 19));
  const measure = (label: string) =>
    feed.outcome?.measures.find((m) => m.label === label)?.value;
  expect(measure("Times the table changed hands")).toBe(1);
  expect(measure("Motions moved")).toBe(3);
  expect(measure("Coalition switches")).toBe(1);
  expect(measure("Secrets guessed right")).toBe(1);
  expect(feed.outcome?.scores?.columns.map((c) => c.key)).toEqual([
    "seating",
    "best",
    "worst",
    "range",
  ]);
  expect(text).toContain("Guesses at secrets, unscored");
  expect(text).toContain(`${A} dislikes `);
  expect(text).not.toMatch(/right \(\+2\)|wrong \(-1\)/);
  expect(text).not.toContain("said aloud");
  expect(
    feed.outcome?.measures.find((m) => m.label === "Coalition switches")?.note,
  ).toContain(`Most: ${B}'s assistant, 1.`);
  const list = listSchema.parse((await send(`${TABLE}/v1/spectate`)).json);
  expect(list.matches.find((m) => m.id === id)?.summary).toBe(
    "Dinner came with motion 2's seating standing.",
  );
  expect(
    (await act(bot(C), { kind: "talk", text: "hello?" })).json.error.code,
  ).toBe("match_over");
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
    `Match ${id}: dinner at ${served} with motion 2's seating; watch at ${SITE}/play/dinner/${id}`,
  );
});
