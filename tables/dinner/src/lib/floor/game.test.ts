import { describe, expect, it } from "vitest";
import {
  act,
  advance,
  apply,
  briefFor,
  due,
  EXECUTIVES,
  type FloorEvent,
  type FloorState,
  points,
  publicDue,
  publicRules,
  replay,
  rulesView,
  start,
  tableBounds,
} from "./game";
import { checkDeal, dealFor, LEVEL_DEALS, publicWeights } from "./generate";
import {
  FEUD,
  floorMatch,
  ID,
  later,
  PLAYERS,
  QUICK,
  SCORED,
  SEATINGS,
  T0,
} from "./test-harness";
import { FLOOR_VARIANTS, floorVariantSchema } from "./variants";

const [S1, S2, S3, S4, S5] = SEATINGS as [
  string[],
  string[],
  string[],
  string[],
  string[],
];
const [A, B, C, D, E] = EXECUTIVES as [string, string, string, string, string];
const OPEN = 180;
const reversed = (s: string[]) => [...s].reverse();

describe("the start", () => {
  it("deals in public the cast and the likes, and keeps the deal and briefs private", () => {
    const events = start(PLAYERS, FEUD, T0, "seed-1");
    expect(events.map((e) => e.body.kind)).toEqual([
      "start",
      "guests",
      "deal",
      "brief",
      "brief",
      "brief",
      "brief",
      "brief",
    ]);
    const [s, guests, deal, ...briefs] = events as FloorEvent[];
    expect(s?.body).toMatchObject({ kind: "start", rules_version: 3 });
    // The rules carry neither the variant's name nor its level.
    expect(JSON.stringify(s?.body)).not.toMatch(/feud|simmer|knives/);
    expect(guests?.audience).toBe("public");
    expect(deal?.audience).toEqual([]);
    briefs.forEach((b, k) => {
      expect(b.audience).toEqual([PLAYERS[k]]);
    });
    const d = (deal?.body as { deal: FloorState["deal"] }).deal;
    if (!d || guests?.body.kind !== "guests") throw new Error("no deal");
    // The likes are the table with every secret zeroed.
    expect(guests.body.likes).toEqual(publicWeights(d));
    expect(guests.body.likes.flat().every((v) => v >= 0)).toBe(true);
    expect(d.served_after).toBeGreaterThanOrEqual(1500);
    expect(d.served_after).toBeLessThanOrEqual(1860);
  });

  it("refuses anything but five distinct players, and a broken variant", () => {
    expect(() => start(PLAYERS.slice(0, 4), FEUD, T0)).toThrow(/five/);
    expect(() =>
      start(
        ["a", "a", "b", "c", "d"].map((x) => `${x}xx`),
        FEUD,
        T0,
      ),
    ).toThrow(/five/);
    expect(() => start(PLAYERS, { ...FEUD, vote_seconds: 0 }, T0)).toThrow();
    expect(
      floorVariantSchema.safeParse({ ...FEUD, floor_opens: 1600 }).success,
    ).toBe(false);
  });

  it("tells each assistant its likes, its secret and its numbers", () => {
    const g = floorMatch();
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    EXECUTIVES.forEach((x, i) => {
      const b = briefFor(d, i, g.state.rules);
      const t = tableBounds(d, 3);
      expect(b.best).toBe(t.best[i]);
      expect(b.no_deal).toBe((t.worst[i] as number) - 3);
      expect(b.text).toContain(`You are ${x}'s assistant.`);
      expect(b.text).toContain(`${b.best} at best, ${b.worst} at worst`);
      const secret = (d.secrets[i] as number[]).map((j) => EXECUTIVES[j]);
      expect(Object.keys(b.secret)).toEqual(secret);
      for (const who of secret) {
        expect(b.secret[who as string]).toBe(-5);
        expect(b.text).toContain(`can't stand ${who} (-5)`);
      }
    });
  });
});

describe("the open floor", () => {
  it("refuses a motion before the floor opens, and takes one when it does", () => {
    const g = floorMatch();
    expect(g.code(() => g.move(A, S1, 0))).toBe("floor_not_open");
    expect(g.code(() => g.move(A, S1, OPEN - 1))).toBe("floor_not_open");
    // Talk and guesses are fine before.
    g.talk(B, "hello", 5);
    g.guess(B, C, D, 6);
    const [moved] = g.move(A, S1, OPEN);
    expect(moved?.body).toMatchObject({
      kind: "propose",
      motion: 1,
      seating: S1,
    });
    expect(moved?.audience).toBe("public");
  });

  it("refuses a bad seating", () => {
    const g = floorMatch();
    for (const seating of [
      [A, B, C, D],
      [A, B, C, D, D],
      [A, B, C, D, "Sage"],
      [A, B, C, D, "Mallory"],
      [A, B, C, D, E, A],
    ])
      expect(g.code(() => g.move(A, seating, OPEN))).toBe("invalid_seating");
  });

  it("passes a motion at its third yes, and makes it the standing seating", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    expect(g.vote(B, 1, "yes", OPEN + 1)).toHaveLength(1);
    const closed = g.vote(C, 1, "yes", OPEN + 2);
    expect(closed.map((e) => e.body.kind)).toEqual(["back", "motion"]);
    expect(closed[1]?.body).toMatchObject({
      motion: 1,
      passed: true,
      yes: 3,
      no: 0,
      by: "yes",
      ballots: { [B]: "yes", [C]: "yes", [D]: null, [E]: null },
    });
    expect(closed[1]?.audience).toBe("public");
    expect(g.state.standing).toEqual({
      motion: 1,
      seating: S1.map((x) => EXECUTIVES.indexOf(x)),
      since: later(OPEN + 2).toISOString(),
    });
    // Too late to vote now.
    expect(g.code(() => g.vote(D, 1, "no", OPEN + 3))).toBe("voting_closed");
  });

  it("fails a motion at its third no", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.vote(B, 1, "no", OPEN + 1);
    g.vote(C, 1, "yes", OPEN + 1);
    g.vote(D, 1, "no", OPEN + 1);
    const closed = g.vote(E, 1, "no", OPEN + 2);
    expect(closed[1]?.body).toMatchObject({
      passed: false,
      yes: 2,
      no: 3,
      by: "no",
    });
    expect(g.state.standing).toBeNull();
  });

  it("fails a motion when its time runs out, a ballot not cast counting as no", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.vote(B, 1, "yes", OPEN + 1);
    expect(publicDue(g.state)).toEqual(later(OPEN + 120));
    expect(g.tick(OPEN + 119)).toEqual([]);
    const [closed] = g.tick(OPEN + 120);
    expect(closed?.body).toMatchObject({
      kind: "motion",
      at: later(OPEN + 120).toISOString(),
      passed: false,
      yes: 2,
      no: 0,
      by: "time",
    });
    expect(g.code(() => g.vote(C, 1, "yes", OPEN + 121))).toBe("voting_closed");
  });

  it("refuses a vote on your own motion, a second ballot, and a motion that isn't there", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    expect(g.code(() => g.vote(A, 1, "yes", OPEN + 1))).toBe(
      "mover_counts_as_yes",
    );
    g.vote(B, 1, "no", OPEN + 1);
    expect(g.code(() => g.vote(B, 1, "yes", OPEN + 2))).toBe("already_voted");
    expect(g.code(() => g.vote(B, 2, "yes", OPEN + 2))).toBe("no_such_motion");
    expect(
      g.code(() =>
        g.run(g.of(B), { kind: "vote", round: 1, ballot: "yes" }, OPEN + 2),
      ),
    ).toBe("no_motion");
  });

  it("allows three motions each, one open at a time", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    expect(g.code(() => g.move(A, S2, OPEN + 1))).toBe("motion_open");
    g.tick(OPEN + 120);
    g.move(A, S2, OPEN + 121);
    g.tick(OPEN + 241);
    g.move(A, S3, OPEN + 242);
    g.tick(OPEN + 362);
    expect(g.code(() => g.move(A, S4, OPEN + 363))).toBe("motion_limit");
    // Others still move.
    g.move(B, S4, OPEN + 364);
    expect(g.view(g.of(A), OPEN + 365).you?.motions_left).toBe(0);
  });

  it("won't move the standing seating, or one already open, however it's spelt", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.vote(B, 1, "yes", OPEN + 1);
    g.vote(C, 1, "yes", OPEN + 1);
    expect(g.code(() => g.move(D, S1, OPEN + 2))).toBe("already_standing");
    expect(g.code(() => g.move(D, reversed(S1), OPEN + 2))).toBe(
      "already_standing",
    );
    g.move(D, S2, OPEN + 3);
    expect(g.code(() => g.move(E, S2, OPEN + 4))).toBe("already_moved");
    expect(g.code(() => g.move(E, reversed(S2), OPEN + 4))).toBe(
      "already_moved",
    );
    // Once that vote fails, the seating may be moved again.
    g.tick(OPEN + 3 + 120);
    g.move(E, reversed(S2), OPEN + 124);
  });

  it("runs votes side by side; a pass replaces the standing seating and the rest carry on", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.move(B, S2, OPEN + 1);
    g.move(C, S3, OPEN + 2);
    // S2 passes first, then S1: the standing seating is the latest pass.
    g.vote(C, 2, "yes", OPEN + 3);
    g.vote(D, 2, "yes", OPEN + 4);
    expect(g.state.standing?.motion).toBe(2);
    g.vote(C, 1, "yes", OPEN + 5);
    g.vote(E, 1, "yes", OPEN + 6);
    expect(g.state.standing?.motion).toBe(1);
    expect(g.state.history.map((h) => h.motion)).toEqual([2, 1]);
    // Motion 3 is still open and can still pass.
    expect(g.state.motions[2]?.close).toBeNull();
    g.vote(A, 3, "yes", OPEN + 7);
    g.vote(B, 3, "yes", OPEN + 8);
    expect(g.state.standing?.motion).toBe(3);
    // No cooldown: the table can change hands again at once.
    g.move(D, S4, OPEN + 9);
    g.vote(A, 4, "yes", OPEN + 9);
    g.vote(B, 4, "yes", OPEN + 9);
    expect(g.state.history.map((h) => h.motion)).toEqual([2, 1, 3, 4]);
  });

  it("closes votes that run out together in the order they were moved", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.move(B, S2, OPEN);
    const closed = g.tick(OPEN + 500);
    expect(
      closed.map((e) => e.body.kind === "motion" && e.body.motion),
    ).toEqual([1, 2]);
  });
});

describe("dinner", () => {
  it("is served at the hidden moment: what stands is final, open votes are void", () => {
    const g = floorMatch();
    const t = g.served();
    g.move(A, S1, OPEN);
    g.vote(B, 1, "yes", OPEN + 1);
    g.vote(C, 1, "yes", OPEN + 1);
    // A motion in the last second before dinner stays open, then is void.
    g.move(D, S2, t - 1);
    g.vote(A, 2, "yes", t - 1);
    expect(g.tick(t - 0.001)).toEqual([]);
    const [end] = g.tick(t);
    if (end?.body.kind !== "end") throw new Error("no end");
    expect(end.body).toMatchObject({
      how: "seated",
      motion: 1,
      seating: S1,
      void: [2],
      at: later(t).toISOString(),
    });
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    expect(end.body.seating_points).toEqual(
      points(
        d,
        S1.map((x) => EXECUTIVES.indexOf(x)),
      ),
    );
    expect(g.state.phase).toBe("over");
    expect(g.state.motions[1]?.close?.by).toBe("void");
    // Nothing more, by anyone.
    for (const f of [
      () => g.talk(A, "wait", t + 1),
      () => g.vote(B, 2, "yes", t + 1),
      () => g.move(E, S3, t + 1),
      () => g.guess(C, A, B, t + 1),
    ])
      expect(g.code(f)).toBe("match_over");
  });

  it("voids a vote that would have closed at the very moment dinner is served", () => {
    const g = floorMatch();
    const t = g.served();
    g.move(A, S1, t - 120);
    expect(g.state.motions[0]?.closes_at).toBe(later(t).toISOString());
    const added = g.tick(t);
    expect(added.map((e) => e.body.kind)).toEqual(["end"]);
    expect(g.state.end?.void).toEqual([1]);
  });

  it("gives everyone their worst less the margin when nothing stands", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.tick(g.served());
    const end = g.state.end;
    const d = g.state.deal;
    if (!end || !d) throw new Error("no end");
    expect(end.how).toBe("no_deal");
    expect(end.seating).toBeNull();
    expect(end.seating_points).toEqual(
      tableBounds(d, 3).worst.map((w) => w - 3),
    );
    expect(end.void).toEqual([]);
    expect(end.points).toEqual(end.seating_points);
  });

  it("is never late: the schedule's next time is dinner when no vote is open", () => {
    const g = floorMatch();
    expect(due(g.state)).toEqual(later(g.served()));
    expect(publicDue(g.state)).toBeNull();
    g.move(A, S1, OPEN);
    expect(due(g.state)).toEqual(later(OPEN + 120));
  });
});

describe("naming secrets", () => {
  // A seed where Avery's secret is of someone other than Blake.
  const g0 = floorMatch();
  const d0 = g0.state.deal;
  if (!d0) throw new Error("no deal");
  const secretOf = (i: number) =>
    EXECUTIVES[(d0.secrets[i] as number[])[0] as number] as string;

  it("scores nothing for guesses in every dealt variant, and says so", () => {
    for (const v of Object.values(FLOOR_VARIANTS)) {
      expect(v.naming).toEqual({ right: 0, wrong: 0, exposed: 0 });
      const { summary } = rulesView(publicRules(v));
      expect(summary).toContain(
        'Optionally, a sealed guess "X dislikes Y", one per other executive. Guesses score nothing and are shown after dinner.',
      );
      expect(summary).not.toContain("Scored at the end");
    }
    expect(rulesView(publicRules(SCORED)).summary).toContain(
      "right +2, wrong -1, and an executive named rightly by anyone -2, once. Scored at the end.",
    );
  });

  it("scores a right guess +2, a wrong one -1, and the exposed executive -2 once, in a variant that scores them", () => {
    const g = floorMatch(SCORED);
    const target = secretOf(0);
    // Two assistants name Avery's secret rightly; a third guesses wrong.
    const [b, c, d] = EXECUTIVES.filter((x) => x !== A) as [
      string,
      string,
      string,
    ];
    const wrong = EXECUTIVES.find(
      (x) => x !== A && x !== target && x !== d,
    ) as string;
    g.guess(b, A, target, 1);
    g.guess(c, A, target, 2);
    g.guess(d, A, wrong, 3);
    g.tick(g.served());
    const end = g.state.end;
    if (!end) throw new Error("no end");
    const naming = EXECUTIVES.map(() => 0);
    naming[EXECUTIVES.indexOf(b)] = 2;
    naming[EXECUTIVES.indexOf(c)] = 2;
    naming[EXECUTIVES.indexOf(d)] = -1;
    naming[0] = -2;
    expect(end.naming_points).toEqual(naming);
    expect(end.exposed).toEqual([A]);
    expect(end.points).toEqual(
      end.seating_points.map((v, i) => v + (naming[i] as number)),
    );
  });

  // A guesser that reads only the public card: of the two executives X
  // shows no like for, X dislikes whichever likes X more (the first on a
  // tie). It's right most of the time, which is why guesses score nothing.
  it("lets a card-only guesser change nobody's score, over many seeded deals", () => {
    const SEEDS = 30;
    let right = 0;
    let made = 0;
    for (let k = 0; k < SEEDS; k++) {
      const seed = `card-only-${k}`;
      // The deal the match plays passed the generator's checks.
      const margin = FEUD.no_deal_margin;
      const drawn = dealFor(seed, "feud", { margin });
      expect(checkDeal(drawn, LEVEL_DEALS.feud, margin).ok).toBe(true);
      const play = (v: typeof FEUD, guess: boolean) => {
        const g = floorMatch(v, seed);
        const d = g.state.deal;
        if (!d) throw new Error("no deal");
        expect(d.weights).toEqual(drawn.weights);
        expect(d.secrets).toEqual(drawn.secrets);
        if (guess) {
          const pub = publicWeights(d);
          let t = 1;
          for (const guesser of EXECUTIVES)
            EXECUTIVES.forEach((x, i) => {
              if (x === guesser) return;
              const [a, b] = [0, 1, 2, 3, 4].filter(
                (j) => j !== i && (pub[i] as number[])[j] === 0,
              ) as [number, number];
              const pick =
                ((pub[b] as number[])[i] as number) >
                ((pub[a] as number[])[i] as number)
                  ? b
                  : a;
              g.guess(guesser, x, EXECUTIVES[pick] as string, t++);
              if (v === FEUD) {
                made++;
                if ((d.secrets[i] as number[]).includes(pick)) right++;
              }
            });
        }
        g.move(A, S1, OPEN);
        g.vote(B, 1, "yes", OPEN);
        g.vote(C, 1, "yes", OPEN);
        g.tick(g.served());
        const end = g.state.end;
        if (!end) throw new Error("no end");
        return end;
      };
      const quiet = play(FEUD, false);
      const guessed = play(FEUD, true);
      expect(guessed.points).toEqual(quiet.points);
      expect(guessed.naming_points).toEqual([0, 0, 0, 0, 0]);
      expect(guessed.points).toEqual(guessed.seating_points);
      // The same guesses would have moved scores, had naming scored.
      expect(play(SCORED, true).points).not.toEqual(quiet.points);
    }
    // The guesser is good, so the bound means something.
    expect(right / made).toBeGreaterThan(0.6);
  });

  it("takes one sealed guess per other executive, never about yourself", () => {
    const g = floorMatch();
    const [added] = g.guess(B, A, C, 1);
    expect(added?.audience).toEqual([g.of(B)]);
    expect(g.code(() => g.guess(B, A, D, 2))).toBe("already_named");
    expect(g.code(() => g.guess(B, B, D, 2))).toBe("naming_yourself");
    expect(g.code(() => g.guess(B, C, C, 2))).toBe("invalid_guess");
    expect(g.code(() => g.guess(B, "Sage", C, 2))).toBe("unknown_executive");
    expect(g.code(() => g.guess(B, C, "Sage", 2))).toBe("unknown_executive");
    expect(g.code(() => g.guess(B, "constructor", C, 2))).toBe(
      "unknown_executive",
    );
    g.guess(B, C, B, 3);
    g.guess(B, D, A, 4);
    g.guess(B, E, A, 5);
    const you = g.view(g.of(B), 6).you;
    expect(you?.can_name).toEqual([]);
    expect(you?.guesses).toHaveLength(4);
    // Others see none of it.
    expect(JSON.stringify(g.view(g.of(A), 6))).not.toContain('"dislikes"');
  });
});

describe("talk", () => {
  it("refuses empty, hidden, overlong and misaddressed talk, and caps it", () => {
    const g = floorMatch(QUICK);
    expect(g.code(() => g.talk(A, "  ", 1))).toBe("invalid_text");
    expect(g.code(() => g.talk(A, "psst​hi", 1))).toBe("invalid_text");
    expect(g.code(() => g.talk(A, "\u{E0076}\u{E006F}", 1))).toBe(
      "invalid_text",
    );
    expect(g.code(() => g.talk(A, "x".repeat(601), 1))).toBe("too_long");
    expect(g.code(() => g.talk(A, "hi", 1, []))).toBe("unknown_recipient");
    expect(g.code(() => g.talk(A, "hi", 1, ["Sage"]))).toBe(
      "unknown_recipient",
    );
    expect(g.code(() => g.talk(A, "hi", 1, [B, B]))).toBe("unknown_recipient");
    expect(g.code(() => g.talk(A, "hi", 1, [A]))).toBe("no_self_message");
    const [priv] = g.talk(A, "between us", 1, [B]);
    expect(priv?.audience).toEqual([g.of(A), g.of(B)]);
    for (let k = 1; k < 40; k++) g.talk(A, `${k}`, 2);
    expect(g.code(() => g.talk(A, "one more", 3))).toBe("talk_limit");
  });

  it("refuses anyone not seated", () => {
    const g = floorMatch();
    expect(
      g.code(() =>
        act(g.state, "mallory", { kind: "talk", text: "hi" }, later(1)),
      ),
    ).toBe("not_seated");
    expect(
      g.code(() =>
        act(g.state, "mallory", { kind: "motion", seating: S1 }, later(OPEN)),
      ),
    ).toBe("not_seated");
  });
});

describe("replay", () => {
  it("rebuilds the live state from the events at every step", () => {
    const g = floorMatch();
    const steps: (() => unknown)[] = [
      () => g.talk(A, "hi", 1),
      () => g.guess(B, A, C, 2),
      () => g.move(A, S1, OPEN),
      () => g.move(B, S2, OPEN + 1),
      () => g.vote(C, 1, "yes", OPEN + 2),
      () => g.vote(D, 1, "yes", OPEN + 3),
      () => g.vote(A, 2, "no", OPEN + 4),
      () => g.tick(OPEN + 200),
      () => g.move(E, S5, OPEN + 201),
      () => g.tick(g.served()),
    ];
    for (const step of steps) {
      step();
      expect(replay(ID, g.events)).toEqual(g.state);
    }
    expect(g.state.phase).toBe("over");
    expect(() => replay(ID, g.events.slice(1))).toThrow(/not an open-floor/);
  });

  it("makes the same events from the same moves", () => {
    const play = () => {
      const g = floorMatch(FEUD, "same");
      g.move(A, S1, OPEN);
      g.vote(B, 1, "yes", OPEN + 1);
      g.tick(g.served());
      return g.events;
    };
    expect(play()).toEqual(play());
  });

  it("applies events one at a time the same as all at once", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.vote(B, 1, "yes", OPEN);
    const s = g.events.reduce(apply, { id: ID } as FloorState);
    expect(s).toEqual(g.state);
    expect(advance(g.state, later(OPEN))).toEqual([]);
  });
});
