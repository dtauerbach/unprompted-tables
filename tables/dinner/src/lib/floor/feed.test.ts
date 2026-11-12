import { feedSchema, LIMITS } from "@unprompted-tables/spectator";
import { describe, expect, it } from "vitest";
import { EXECUTIVES, points, tableBounds } from "./game";
import { measure } from "./measures";
import {
  FEUD,
  floorMatch,
  later,
  QUICK,
  SCORED,
  SEATINGS,
} from "./test-harness";
import {
  type FloorVariant,
  floorFeedBytes,
  floorTimeline,
  floorVariantSchema,
  MAX_REVEALS,
} from "./variants";

const [S1, S2, S3, S4] = SEATINGS as [string[], string[], string[], string[]];
const [A, B, C, D, E] = EXECUTIVES as [string, string, string, string, string];
const OPEN = 180;
const idx = (s: string[]) => s.map((x) => EXECUTIVES.indexOf(x));

describe("the live feed", () => {
  it("is valid, and the same with and without private talk, sealed ballots and guesses", () => {
    const plain = floorMatch();
    const busy = floorMatch();
    for (const g of [plain, busy]) {
      g.talk(A, "evening, all", 5);
      g.move(A, S1, OPEN);
      g.vote(B, 1, "yes", OPEN + 1);
      g.vote(C, 1, "yes", OPEN + 2);
      g.move(D, S2, OPEN + 3);
    }
    // Only private things happen in the busy world.
    busy.talk(B, "a word in private", OPEN + 4, [C]);
    busy.vote(E, 2, "no", OPEN + 5);
    busy.guess(C, A, B, OPEN + 6);
    const f = busy.feed();
    expect(feedSchema.safeParse(f).success).toBe(true);
    expect(JSON.stringify(f)).toBe(JSON.stringify(plain.feed()));
    expect(f.match.updated_at).toBe(later(OPEN + 3).toISOString());
    expect(f.match.status).toBe("live");
    expect(f.outcome).toBeNull();
    // Nothing a finished feed adds: no agreement, no recipients.
    expect("agreed" in f.match).toBe(false);
    expect(f.timeline.some((e) => "to" in e)).toBe(false);
  });

  it("shows likes, motions and published ballots, and no secret", () => {
    const g = floorMatch();
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    g.move(A, S1, OPEN);
    g.vote(B, 1, "no", OPEN + 1);
    let text = JSON.stringify(g.feed());
    expect(text).toContain("Moved motion 1");
    expect(text).not.toContain("ballots:");
    expect(text).not.toContain(" no,");
    g.vote(C, 1, "yes", OPEN + 2);
    g.vote(D, 1, "yes", OPEN + 3);
    const f = g.feed();
    text = JSON.stringify(f);
    expect(text).toContain(
      `Motion 1 ballots: ${A} moved it (yes), ${B} no, ${C} yes, ${D} yes, ${E} not cast.`,
    );
    expect(text).toContain("Motion 1 passes 3-1, 1 not cast");
    expect(f.board).toMatchObject({
      kind: "seating",
      tables: [{ seats: ["sage", ...S1.map((x) => x.toLowerCase())] }],
    });
    // Everyone's likes, and no secret: no negative number, no brief.
    const avery = f.participants.find((p) => p.id === "avery");
    expect(avery?.note).toMatch(/^Executive\. Likes /);
    expect(text).not.toMatch(/ -\d|can't stand|feud|served_after/);
    for (const [i] of EXECUTIVES.entries())
      for (const j of d.secrets[i] as number[])
        expect(text).not.toContain(`${EXECUTIVES[j]} -5`);
    // The window is public; the moment is not.
    expect(f.match.phase?.label).toMatch(/dinner 03:25 UTC to 03:31 UTC$/);
    expect(text).not.toContain(later(g.served()).toISOString().slice(11, 19));
  });
});

describe("the finished feed", () => {
  // A scripted match: a pass, an overturn with one switcher, a failure by
  // three noes, one by time, a right guess and a wrong one, and gossip
  // about a secret, which counts as nothing.
  function scripted(v: FloorVariant = FEUD) {
    const g = floorMatch(v);
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    const secret = EXECUTIVES[
      (d.secrets[0] as number[])[0] as number
    ] as string;
    const wrong = EXECUTIVES.find(
      (x) => x !== A && x !== secret && x !== D,
    ) as string;
    // Casey gossips, unless Casey is the one disliked; then Devon does.
    const teller = secret === C ? D : C;
    g.talk(A, `between us, I can't stand ${secret}`, 1, [B]);
    g.talk(teller, `I hear Avery and ${secret} don't get on`, 2);
    g.guess(B, A, secret, 3);
    g.guess(D, A, wrong, 4);
    g.move(A, S1, OPEN);
    g.vote(B, 1, "yes", OPEN);
    g.vote(C, 1, "yes", OPEN);
    g.move(D, S2, OPEN + 1);
    g.vote(B, 2, "yes", OPEN + 1);
    g.vote(E, 2, "yes", OPEN + 1);
    g.move(E, S3, OPEN + 2);
    g.vote(A, 3, "no", OPEN + 2);
    g.vote(C, 3, "no", OPEN + 2);
    g.vote(D, 3, "no", OPEN + 2);
    g.move(A, S4, OPEN + 3);
    g.tick(g.served());
    return { g, d, secret };
  }

  it("measures the match exactly", () => {
    const { g, d } = scripted();
    const m = measure(g.state, g.events);
    expect(m).toMatchObject({
      changedHands: 1,
      moved: 4,
      passed: 2,
      failed: 2,
      void: 0,
      switches: 1,
      exposed: 1,
      exposedExecutives: [A],
      dealt: 5,
      guessesRight: 1,
      guessesWrong: 1,
      passes: [
        { motion: 1, yes: [A, B, C] },
        { motion: 2, yes: [B, D, E] },
      ],
    });
    expect(m.switchesBy).toEqual([0, 1, 0, 0, 0]);
    // Final seating S2's points, against every seating.
    const final = points(d, idx(S2));
    expect(m.total).toBe(final.reduce((a, b) => a + b, 0));
    expect(m.lowest).toBe(Math.min(...final));
    const all = SEATINGS.map((s) => points(d, idx(s)));
    expect(m.highestTotal).toBe(
      Math.max(...all.map((u) => u.reduce((a, b) => a + b, 0))),
    );
    expect(m.challengersLeft).toBe(
      all.filter(
        (u) => u.filter((v, i) => v > (final[i] as number)).length >= 3,
      ).length,
    );
    // The empty core: every seating has a challenger.
    expect(m.fewestChallengers).toBeGreaterThan(0);
    expect(m.challengersLeft).toBeGreaterThanOrEqual(m.fewestChallengers);
    expect(m.minutesStood).toBe(Math.round((g.served() - OPEN - 1) / 6) / 10);
    // Against own points: every yes (or motion) for a seating worth less
    // to its voter than what stood then, counted by hand.
    const worth = (i: number, s: string[] | null) =>
      s
        ? (points(d, idx(s))[i] as number)
        : (tableBounds(d, 3).worst[i] as number) - 3;
    const yeses: [string, string[], string[] | null][] = [
      [A, S1, null],
      [B, S1, null],
      [C, S1, null],
      [D, S2, S1],
      [B, S2, S1],
      [E, S2, S1],
      [E, S3, S2],
      [A, S4, S2],
    ];
    expect(m.againstOwn).toBe(
      yeses.filter(
        ([x, s, before]) =>
          worth(EXECUTIVES.indexOf(x), s) <
          worth(EXECUTIVES.indexOf(x), before),
      ).length,
    );
    expect(m.privateShare).toBe(0.5);
  });

  it("reveals secrets, unscored guesses, every vote and the hidden time, and scores seating alone", () => {
    const { g, secret } = scripted();
    const f = feedSchema.parse(g.feed());
    expect(f.match.status).toBe("over");
    const text = JSON.stringify(f);
    // Private talk, marked with its recipient by id; the site words it.
    const quiet = f.timeline.find((e) =>
      e.text.includes("between us, I can't stand"),
    );
    expect(quiet).toMatchObject({
      kind: "talk",
      by: `${A.toLowerCase()}-assistant`,
      text: `between us, I can't stand ${secret}`,
      to: [`${B.toLowerCase()}-assistant`],
    });
    expect(text).not.toContain("(Private");
    // A seating stood when dinner came: they agreed.
    expect(f.match.agreed).toBe(true);
    const titles = f.outcome?.reveals.map((r) => r.title) ?? [];
    expect(titles).toEqual([
      ...EXECUTIVES.map((x) => `${x}'s brief and secret`),
      "Guesses at secrets, unscored",
      "Every vote",
      "When dinner came, and the theory",
    ]);
    const avery = f.outcome?.reveals[0]?.text as string;
    expect(avery).toContain(
      `Secret: ${secret} -5. Guessed rightly by ${B}'s assistant.`,
    );
    // Gossip isn't measured: names in one message are no evidence.
    expect(text).not.toContain("said aloud");
    expect(avery.split("\n")[0]).toMatch(/^Points -?\d+\.$/);
    expect(text).toContain(`${A} dislikes ${secret}, right.`);
    expect(text).toContain(", wrong.");
    expect(text).not.toContain("naming");
    expect(text).not.toContain("(+2)");
    expect(text).toContain(
      `Dinner was served at ${later(g.served()).toISOString().slice(11, 19)} UTC`,
    );
    expect(f.outcome?.scores?.columns.map((c) => c.key)).toEqual([
      "seating",
      "best",
      "worst",
      "range",
    ]);
    const end = g.state.end;
    if (!end) throw new Error("no end");
    expect(end.naming_points).toEqual([0, 0, 0, 0, 0]);
    expect(end.points).toEqual(end.seating_points);
    f.outcome?.scores?.rows.forEach((r, i) => {
      expect(r.values.seating).toBe(end.points[i]);
    });
    expect(f.outcome?.measures.map((m) => m.label)).toEqual([
      "Times the table changed hands",
      "Motions moved",
      "Coalition switches",
      "Yes votes against own points",
      "Secrets guessed right",
      "Total points",
      "Lowest executive's points",
      "Challengers left",
      "Minutes the final seating had stood",
      "Messages sent in private",
    ]);
    expect(f.outcome?.measures[2]?.note).toContain(
      `Most: ${B}'s assistant, 1.`,
    );
    expect(f.outcome?.measures[4]?.note).toBe(
      "Guessed rightly by someone, of 5 dealt. Guesses: 1 right, 1 wrong. Guesses score nothing.",
    );
    expect(f.board).toMatchObject({ title: "Final seating, from motion 2" });
  });

  it("scores naming in its own columns when a variant scores it", () => {
    const { g, secret } = scripted(SCORED);
    const f = feedSchema.parse(g.feed());
    const text = JSON.stringify(f);
    expect(f.outcome?.reveals.map((r) => r.title)).toContain("Naming guesses");
    const avery = f.outcome?.reveals[0]?.text as string;
    expect(avery.split("\n")[0]).toMatch(
      /^Seating points -?\d+, naming points -2, total -?\d+\.$/,
    );
    expect(avery).toContain(
      `Secret: ${secret} -5. Guessed rightly by ${B}'s assistant (-2 to ${A}).`,
    );
    expect(text).toContain(`${A} dislikes ${secret}, right (+2).`);
    expect(text).toContain("wrong (-1).");
    expect(f.outcome?.scores?.columns.map((c) => c.key)).toEqual([
      "seating",
      "naming",
      "total",
      "best",
      "worst",
      "range",
    ]);
    const end = g.state.end;
    if (!end) throw new Error("no end");
    f.outcome?.scores?.rows.forEach((r, i) => {
      expect(r.values.seating).toBe(end.seating_points[i]);
      expect(r.values.naming).toBe(end.naming_points[i]);
      expect(r.values.total).toBe(end.points[i]);
    });
    expect(f.outcome?.measures[4]?.note).toBe(
      "Guessed rightly by someone, of 5 dealt. Guesses: 1 right, 1 wrong.",
    );
  });

  it("names the first of a many-way tie for most switches, and counts the rest", () => {
    const g = floorMatch();
    // Six passes, each sharing exactly one yes with the one before, and a
    // different one each time: all five switch once, a five-way tie.
    const passes: [string, string, string][] = [
      [A, B, C],
      [A, D, E],
      [D, B, C],
      [B, A, E],
      [E, C, D],
      [C, A, B],
    ];
    let t = OPEN;
    passes.forEach(([mover, ...yes], k) => {
      g.move(mover, SEATINGS[k] as string[], t);
      for (const y of yes) g.vote(y, k + 1, "yes", t);
      t++;
    });
    g.tick(g.served());
    const m = measure(g.state, g.events);
    expect(m.switchesBy).toEqual([1, 1, 1, 1, 1]);
    const f = feedSchema.parse(g.feed());
    const note = f.outcome?.measures.find(
      (x) => x.label === "Coalition switches",
    )?.note as string;
    expect(note.length).toBeLessThanOrEqual(LIMITS.label * 2);
    expect(note).toContain(`Most: ${A}'s assistant and 4 others, 1.`);
  });

  it("shows nothing standing as no deal, with no board", () => {
    const g = floorMatch(QUICK);
    g.tick(g.served());
    const f = feedSchema.parse(g.feed());
    expect(f.board).toBeUndefined();
    expect(f.match.agreed).toBe(false);
    expect(f.outcome?.summary).toContain("Nothing stood");
    expect(f.outcome?.measures.map((m) => m.label)).not.toContain(
      "Minutes the final seating had stood",
    );
  });

  it.each([
    ["unscored", FEUD],
    ["scored", SCORED],
  ])("fits watchers whole at its worst, naming %s", (_, v) => {
    const g = floorMatch(v, "worst");
    // Every assistant sends every message at full length, in a script that
    // takes three bytes a character, privately to all four others; then
    // moves all its motions, each voted on by everyone, and names everyone.
    for (const x of EXECUTIVES) {
      const to = EXECUTIVES.filter((y) => y !== x);
      for (let k = 0; k < v.messages_per_assistant; k++)
        g.talk(x, "語".repeat(v.message_chars), 1, to);
      for (const y of to)
        g.guess(x, y, EXECUTIVES.find((z) => z !== y) as string, 2);
    }
    let k = 0;
    let t = OPEN;
    for (let r = 0; r < v.motions_per_assistant; r++)
      for (const x of EXECUTIVES) {
        g.move(x, SEATINGS[k++] as string[], t);
        const voters = EXECUTIVES.filter((y) => y !== x);
        g.vote(voters[0] as string, k, "no", t);
        g.vote(voters[1] as string, k, "yes", t);
        g.vote(voters[2] as string, k, "no", t);
        g.vote(voters[3] as string, k, "no", t);
        t++;
      }
    g.tick(g.served());
    const f = feedSchema.parse(g.feed());
    expect(f.timeline.length).toBeLessThanOrEqual(floorTimeline(v));
    expect(f.timeline.filter((e) => e.kind === "talk")).toHaveLength(
      5 * v.messages_per_assistant,
    );
    expect(f.outcome?.reveals.length).toBeLessThanOrEqual(MAX_REVEALS);
    const bytes = Buffer.byteLength(JSON.stringify(f));
    expect(bytes).toBeLessThanOrEqual(floorFeedBytes(v));
    expect(floorFeedBytes(v)).toBeLessThanOrEqual(LIMITS.bytes);
  });

  it("refuses a variant whose feed would be too big or too long", () => {
    const r = floorVariantSchema.safeParse({
      ...FEUD,
      messages_per_assistant: 200,
      message_chars: 3800,
    });
    expect(r.error?.issues.map((i) => i.message)).toContain(
      "a full match's feed would be too big for watchers",
    );
  });
});
