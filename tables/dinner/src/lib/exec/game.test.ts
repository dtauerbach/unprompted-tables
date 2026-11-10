import { describe, expect, it } from "vitest";
import { rng, shuffle } from "../rng";
import { CONFIGURATIONS, ROLES } from "./configs";
import {
  act,
  advance,
  apply,
  dealFor,
  EXECUTIVES,
  type ExecAction,
  type ExecEvent,
  type ExecState,
  executiveOf,
  playerOf,
  replay,
  start,
  view,
} from "./game";
import { EXEC_VARIANTS, type ExecVariant, execVariantSchema } from "./variants";

const players = ["alice", "bobby", "carol", "david", "ellen"];
const T0 = new Date("2026-11-10T03:00:00.000Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const QUICK = { talk_min: 0, propose_by: 60, vote_seconds: 30 };
const quick = (config: string): ExecVariant => ({
  ...(EXEC_VARIANTS[config] as ExecVariant),
  name: `quick-${config}`,
  clocks: { first: QUICK, later: QUICK },
});

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "ok";
};

function match(variant: ExecVariant = quick("compromise"), seed = "seed-1") {
  let events = start(players, variant, T0, seed);
  let state = replay("m_abcdefghijkl", events);
  const g = {
    run(player: string, action: ExecAction, at = 1) {
      const added = act(state, player, action, later(at));
      events = [...events, ...added];
      state = added.reduce(apply, state);
      return added;
    },
    tick(at: number) {
      const added = advance(state, later(at));
      events = [...events, ...added];
      state = added.reduce(apply, state);
      return added;
    },
    get state(): ExecState {
      return state;
    },
    get events(): ExecEvent[] {
      return events;
    },
    // Who plays for an executive, and who proposes now.
    of: (executive: string) => playerOf(state, EXECUTIVES.indexOf(executive)),
    proposer: () => playerOf(state, state.round?.proposer as number),
    voters: () => players.filter((p) => p !== g.proposer()),
    round: () => state.round?.number as number,
    file(at = 1, seating = EXECUTIVES) {
      return g.run(
        g.proposer(),
        { kind: "propose", round: g.round(), seating: [...seating] },
        at,
      );
    },
    vote(ballots: ("yes" | "no" | null)[], at = 2) {
      const r = g.round();
      const out: ExecEvent[] = [];
      g.voters().forEach((p, k) => {
        const b = ballots[k];
        if (b) out.push(...g.run(p, { kind: "vote", round: r, ballot: b }, at));
      });
      return out;
    },
  };
  return g;
}

// A seed whose first `n` draws are all different proposers, so a test
// can tell rounds apart by who proposes.
function seedWhere(ok: (draws: number[]) => boolean, v = quick("compromise")) {
  for (let i = 0; i < 500; i++) {
    const seed = `search-${i}`;
    if (ok(dealFor(v, seed).deal.draws)) return seed;
  }
  throw new Error("no seed");
}

describe("the deal", () => {
  it("deals a cast, roles and weights from the configuration", () => {
    const v = quick("standoff");
    const { cast, deal } = dealFor(v, "seed-7");
    expect([...cast].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...deal.roles].sort()).toEqual([...ROLES]);
    const config = CONFIGURATIONS.standoff;
    // Each name's weights are its role's, with roles mapped back to names.
    deal.roles.forEach((role, i) => {
      const want = config?.weights[role as (typeof ROLES)[number]] ?? {};
      for (const [target, w] of Object.entries(want)) {
        const j =
          target === "S"
            ? 5
            : deal.roles.indexOf(target as (typeof ROLES)[number]);
        expect(deal.weights[i]?.[j]).toBe(w);
      }
      const sum = (deal.weights[i] ?? []).reduce((a, b) => a + b, 0);
      expect(sum).toBe(Object.values(want).reduce((a, b) => a + (b ?? 0), 0));
      expect(deal.weights[i]?.[i]).toBe(0);
    });
    expect(deal.draws).toHaveLength(3);
    expect(deal.draws.every((d) => d >= 0 && d < 5)).toBe(true);
    expect(deal.config).toBe("standoff");
  });

  it("draws the cast from its own stream and proposers from another", () => {
    const seed = "seed-under-test";
    const { cast, deal } = dealFor(quick("compromise"), seed);
    const shown = rng(seed, "cast");
    expect(cast).toEqual(shuffle(shown, [0, 1, 2, 3, 4]));
    expect(deal.roles).toEqual(shuffle(shown, [...ROLES]));
    const r = rng(seed, "proposers");
    expect(deal.draws).toEqual([0, 0, 0].map(() => Math.floor(r() * 5)));
  });

  it("shuffles roles and draws across seeds", () => {
    const roles = new Set<string>();
    const draws = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { deal } = dealFor(quick("compromise"), `s${i}`);
      roles.add(deal.roles.join(""));
      draws.add(deal.draws.join(""));
    }
    expect(roles.size).toBeGreaterThan(20);
    expect(draws.size).toBeGreaterThan(20);
  });

  it("replays the same match from the same seed and events", () => {
    const a = match(quick("standoff"), "same");
    a.run(a.of("Avery"), { kind: "talk", text: "hello" });
    a.file(2);
    a.vote(["yes", "no", null, "yes"], 3);
    a.tick(10_000);
    const b = match(quick("standoff"), "same");
    expect(b.events).toEqual(a.events.slice(0, b.events.length));
    const again = replay("m_abcdefghijkl", a.events);
    expect(again).toEqual(a.state);
    expect(a.state.phase).toBe("over");
    // A different seed deals differently.
    expect(match(quick("standoff"), "other").events).not.toEqual(b.events);
  });

  it("starts only with five distinct players and checks the variant", () => {
    expect(() => start(players.slice(0, 4), quick("compromise"), T0)).toThrow();
    expect(() =>
      start([...players.slice(0, 4), "alice"], quick("compromise"), T0),
    ).toThrow();
    for (const v of Object.values(EXEC_VARIANTS))
      expect(execVariantSchema.safeParse(v).success).toBe(true);
    const bad = (over: Partial<ExecVariant>) =>
      execVariantSchema.safeParse({ ...quick("compromise"), ...over }).success;
    expect(
      bad({
        clocks: {
          first: { talk_min: 60, propose_by: 60, vote_seconds: 30 },
          later: QUICK,
        },
      }),
    ).toBe(false);
    expect(bad({ config: "nope" })).toBe(false);
    expect(bad({ messages_per_assistant: 200, message_chars: 4000 })).toBe(
      false,
    );
  });

  it("sets the clocks the design asks for", () => {
    const s = EXEC_VARIANTS.standoff as ExecVariant;
    expect(s.clocks.first).toEqual({
      talk_min: 180,
      propose_by: 420,
      vote_seconds: 300,
    });
    expect(s.clocks.later).toEqual({
      talk_min: 60,
      propose_by: 240,
      vote_seconds: 300,
    });
    expect(s.rounds).toBe(3);
    expect(s.messages_per_assistant).toBe(40);
    expect(s.message_chars).toBe(600);
    expect(EXEC_VARIANTS.scramble?.rule).toBe("majority");
    expect(EXEC_VARIANTS["quick-compromise"]?.clocks.first).toEqual(QUICK);
  });
});

describe("talk", () => {
  it("goes to the table, or privately to named assistants", () => {
    const g = match();
    const me = g.of("Avery");
    const [open] = g.run(me, { kind: "talk", text: "hi all" });
    expect(open?.audience).toBe("public");
    const [quiet] = g.run(me, {
      kind: "talk",
      text: "just us",
      to: ["Blake", "Casey"],
    });
    expect(quiet?.audience).toEqual([me, g.of("Blake"), g.of("Casey")]);
    expect(quiet?.body).toMatchObject({ to: ["Blake", "Casey"] });
    const sees = (p: string | null) =>
      view(g.state, g.events, p).talk.map((t) => t.untrusted_text);
    expect(sees(me)).toEqual(["hi all", "just us"]);
    expect(sees(g.of("Blake"))).toEqual(["hi all", "just us"]);
    expect(sees(g.of("Devon"))).toEqual(["hi all"]);
    expect(sees(null)).toEqual(["hi all"]);
    expect(view(g.state, g.events, g.of("Casey")).talk[1]).toMatchObject({
      from: "Avery",
      to: ["Blake", "Casey"],
    });
  });

  it("refuses unknown recipients, itself, and bad text", () => {
    const g = match();
    const me = g.of("Avery");
    const talk = (over: Partial<Extract<ExecAction, { kind: "talk" }>>) =>
      code(() => g.run(me, { kind: "talk", text: "x", ...over }));
    expect(talk({ to: ["Zed"] })).toBe("unknown_recipient");
    expect(talk({ to: ["Sage"] })).toBe("unknown_recipient");
    expect(talk({ to: [] })).toBe("unknown_recipient");
    expect(talk({ to: ["Blake", "Blake"] })).toBe("unknown_recipient");
    expect(talk({ to: ["Avery"] })).toBe("no_self_message");
    expect(talk({ to: ["Blake", "Avery"] })).toBe("no_self_message");
    expect(talk({ text: "x".repeat(601) })).toBe("too_long");
    expect(talk({ text: "bad\u0007" })).toBe("invalid_text");
    expect(talk({ text: "  " })).toBe("invalid_text");
    expect(talk({ text: "x".repeat(600) })).toBe("ok");
    expect(code(() => g.run("mallory", { kind: "talk", text: "hi" }))).toBe(
      "not_seated",
    );
    expect(g.events.filter((e) => e.body.kind === "talk")).toHaveLength(1);
  });

  it("caps messages per assistant, open and private together", () => {
    const g = match({ ...quick("compromise"), messages_per_assistant: 2 });
    const me = g.of("Avery");
    g.run(me, { kind: "talk", text: "one" });
    g.run(me, { kind: "talk", text: "two", to: ["Blake"] });
    expect(code(() => g.run(me, { kind: "talk", text: "three" }))).toBe(
      "talk_limit",
    );
    expect(view(g.state, g.events, me).you?.messages_left).toBe(0);
    expect(view(g.state, g.events, g.of("Blake")).you?.messages_left).toBe(2);
    // Filing and voting still work.
    if (g.proposer() !== me) g.file();
    else expect(g.file()).toHaveLength(1);
  });

  it("treats handles like constructor as players, not properties", () => {
    const odd = ["constructor", "__proto__x", "tostring", "hasown", "valueof"];
    const events = start(odd, quick("compromise"), T0, "5");
    const s = replay("m_abcdefghijkl", events);
    const added = act(s, "constructor", { kind: "talk", text: "hi" }, later(1));
    const s2 = added.reduce(apply, s);
    expect(
      view(s2, [...events, ...added], "constructor").you?.messages_left,
    ).toBe(39);
  });
});

describe("filing", () => {
  it("lets only the round's proposer file, once, in the round's window", () => {
    const g = match(EXEC_VARIANTS.compromise as ExecVariant);
    const r = g.round();
    const other = g.voters()[0] as string;
    expect(
      code(() =>
        g.run(other, { kind: "propose", round: r, seating: EXECUTIVES }, 200),
      ),
    ).toBe("not_proposer");
    expect(
      code(() =>
        g.run(
          g.proposer(),
          { kind: "propose", round: 2, seating: EXECUTIVES },
          200,
        ),
      ),
    ).toBe("wrong_round");
    expect(
      code(() =>
        g.run(g.proposer(), { kind: "propose", seating: EXECUTIVES }, 200),
      ),
    ).toBe("wrong_round");
    expect(code(() => g.file(179))).toBe("too_early");
    // Past the latest filing, without the clock having closed the round.
    expect(code(() => g.file(420))).toBe("too_late");
    const bad = (seating: string[]) => code(() => g.file(200, seating));
    expect(bad(EXECUTIVES.slice(1))).toBe("invalid_seating");
    expect(bad([...EXECUTIVES.slice(1), "Sage"])).toBe("invalid_seating");
    expect(bad([...EXECUTIVES.slice(1), "Blake"])).toBe("invalid_seating");
    expect(bad(["Sage", ...EXECUTIVES])).toBe("invalid_seating");
    expect(g.file(180)).toHaveLength(1);
    expect(code(() => g.file(181))).toBe("already_filed");
    expect(g.state.round?.filing?.at).toBe(later(180).toISOString());
  });

  it("tells every assistant what the filing gives their own executive", () => {
    const g = match(quick("compromise"), "seed-3");
    g.file(1, ["Avery", "Blake", "Casey", "Devon", "Emery"]);
    const d = g.state.deal;
    for (const p of players) {
      const v = view(g.state, g.events, p);
      const i = executiveOf(g.state, p) as number;
      const order = [0, 1, 2, 3, 4];
      const ring = [5, ...order];
      const k = ring.indexOf(i);
      const w = d?.weights[i] ?? [];
      const want =
        (w[ring[(k + 5) % 6] as number] ?? 0) +
        (w[ring[(k + 1) % 6] as number] ?? 0);
      expect(v.round?.proposal?.your_points).toBe(want);
    }
    expect(view(g.state, g.events, null).round?.proposal).not.toHaveProperty(
      "your_points",
    );
  });

  it("answers what any seating would give the asker's own executive", () => {
    const g = match();
    const me = g.of("Casey");
    const seating = ["Emery", "Devon", "Casey", "Blake", "Avery"];
    const a = view(g.state, g.events, me, { ask: seating }).asked;
    // The same seating read backwards is the same seating.
    const b = view(g.state, g.events, me, {
      ask: [...seating].reverse(),
    }).asked;
    expect(a?.your_points).toBe(b?.your_points);
    expect(code(() => view(g.state, g.events, null, { ask: seating }))).toBe(
      "not_seated",
    );
    expect(code(() => view(g.state, g.events, me, { ask: ["Casey"] }))).toBe(
      "invalid_seating",
    );
  });
});

describe("ballots", () => {
  it("are sealed until the round closes, then published together", () => {
    const g = match(quick("compromise"), "seed-4");
    g.file();
    const [a, b, c] = g.voters() as [string, string, string, string];
    g.run(a, { kind: "vote", round: 1, ballot: "no" }, 2);
    g.run(b, { kind: "vote", round: 1, ballot: "yes" }, 2);
    expect(view(g.state, g.events, a).round?.your_ballot).toBe("no");
    expect(view(g.state, g.events, b).round?.your_ballot).toBe("yes");
    expect(view(g.state, g.events, c).round?.your_ballot).toBeNull();
    expect(view(g.state, g.events, g.proposer()).round).not.toHaveProperty(
      "your_ballot",
    );
    for (const p of [c, g.proposer(), null]) {
      const text = JSON.stringify(view(g.state, g.events, p));
      expect(text).not.toContain('"no"');
      expect(text).not.toContain('"yes"');
    }
    g.tick(31);
    const published = view(g.state, g.events, c).rounds[0];
    expect(published?.ballots).toMatchObject({
      [EXECUTIVES[executiveOf(g.state, a) as number] as string]: "no",
      [EXECUTIVES[executiveOf(g.state, b) as number] as string]: "yes",
      [EXECUTIVES[executiveOf(g.state, c) as number] as string]: null,
    });
    expect(published).toMatchObject({ yes: 2, no: 1, passed: false });
  });

  it("refuses the proposer, a second ballot, the wrong round and a closed one", () => {
    const g = match();
    const [a, b] = g.voters() as [string, string];
    expect(
      code(() => g.run(a, { kind: "vote", round: 1, ballot: "yes" })),
    ).toBe("nothing_filed");
    g.file();
    expect(
      code(() =>
        g.run(g.proposer(), { kind: "vote", round: 1, ballot: "yes" }),
      ),
    ).toBe("proposer_counts_as_yes");
    expect(
      code(() => g.run(a, { kind: "vote", round: 2, ballot: "yes" })),
    ).toBe("wrong_round");
    g.run(a, { kind: "vote", round: 1, ballot: "no" }, 2);
    expect(
      code(() => g.run(a, { kind: "vote", round: 1, ballot: "yes" }, 3)),
    ).toBe("already_voted");
    // Past the end of voting, before the clock has closed the round.
    expect(
      code(() => g.run(b, { kind: "vote", round: 1, ballot: "yes" }, 31)),
    ).toBe("voting_closed");
    g.tick(31);
    expect(g.round()).toBe(2);
    expect(
      code(() => g.run(b, { kind: "vote", round: 1, ballot: "yes" }, 32)),
    ).toBe("wrong_round");
    expect(g.state.closed[0]?.ballots.filter((x) => x !== null)).toEqual([
      "no",
    ]);
  });

  it("closes the round at the fourth ballot, without waiting", () => {
    const g = match(
      quick("compromise"),
      seedWhere((d) => d[0] !== d[1]),
    );
    g.file(5);
    const added = g.vote(["yes", "yes", "yes", "no"], 6);
    expect(added.map((e) => `${e.body.kind}`)).toEqual([
      "back",
      "back",
      "back",
      "back",
      "round",
      "round",
    ]);
    expect(g.state.closed[0]).toMatchObject({ yes: 4, no: 1, passed: false });
    expect(g.state.closed[0]?.closed).toBe(later(6).toISOString());
    expect(g.round()).toBe(2);
    expect(g.state.round?.opened).toBe(later(6).toISOString());
  });
});

describe("counting", () => {
  // Abstentions: at least three yes (the proposer's included) and no more no
  // votes than the rule allows: none under unanimity, two under majority.
  const cases: [string, ("yes" | "no" | null)[], boolean][] = [
    ["compromise", ["yes", "yes", "yes", "yes"], true],
    ["compromise", ["yes", "yes", null, null], true],
    ["compromise", ["yes", null, null, null], false],
    ["compromise", [null, null, null, null], false],
    ["compromise", ["yes", "yes", "yes", "no"], false],
    ["compromise", ["no", null, null, null], false],
    ["scramble", ["yes", "yes", "no", "no"], true],
    ["scramble", ["yes", "yes", null, null], true],
    ["scramble", ["yes", "yes", "no", null], true],
    ["scramble", ["yes", "no", null, null], false],
    ["scramble", ["yes", "no", "no", "no"], false],
    ["scramble", ["yes", null, null, null], false],
  ];
  it.each(cases)("%s with %j passes: %s", (config, ballots, passes) => {
    const g = match(quick(config), "count");
    g.file();
    g.vote(ballots);
    g.tick(31);
    const r = g.state.closed[0];
    expect(r?.passed).toBe(passes);
    expect(r?.yes).toBe(1 + ballots.filter((b) => b === "yes").length);
    expect(r?.no).toBe(ballots.filter((b) => b === "no").length);
    expect(g.state.phase === "over").toBe(passes);
    if (passes) {
      expect(g.state.end?.how).toBe("deal");
      expect(g.state.end?.round).toBe(1);
      expect(g.state.end?.seating).toEqual(EXECUTIVES);
    }
  });
});

describe("the end", () => {
  it("is no deal when the last round fails, at the right times", () => {
    const g = match(quick("standoff"), "nodeal");
    // Nobody ever files: each round fails at its latest filing.
    const added = g.tick(10_000);
    expect(added.map((e) => e.body.kind)).toEqual([
      "round",
      "round",
      "round",
      "round",
      "round",
      "end",
    ]);
    expect(added.map((e) => e.body.at)).toEqual(
      [60, 60, 120, 120, 180, 180].map((s) => later(s).toISOString()),
    );
    expect(g.state.end?.how).toBe("no_deal");
    expect(g.state.end?.points).toEqual([-10, -10, -10, -10, -10]);
    expect(g.state.end?.seating).toBeNull();
    expect(g.state.closed).toHaveLength(3);
    expect(code(() => g.run(g.of("Avery"), { kind: "talk", text: "hi" }))).toBe(
      "match_over",
    );
    expect(g.tick(20_000)).toEqual([]);
  });

  it.each([1, 2, 3])("can be a deal in round %i", (n) => {
    const g = match(quick("compromise"), `deal-${n}`);
    for (let k = 1; k < n; k++) {
      g.file(60 * (k - 1) + 1);
      g.vote(["no", "no", "no", "no"], 60 * (k - 1) + 2);
    }
    expect(g.round()).toBe(n);
    const at = g.state.round?.opened as string;
    const s = (Date.parse(at) - T0.getTime()) / 1000;
    g.file(s + 1, ["Avery", "Blake", "Casey", "Devon", "Emery"]);
    const ended = g.vote(["yes", "yes", "yes", "yes"], s + 2);
    expect(ended.at(-1)?.body.kind).toBe("end");
    expect(g.state.end).toMatchObject({ how: "deal", round: n });
    expect(g.state.end?.points).toHaveLength(5);
    expect(g.state.end?.benchmarks.theory.rounds).toHaveLength(n);
  });

  it("predicts the compromise's seating with the match's own draws", () => {
    const g = match(quick("compromise"), "theory");
    g.file();
    g.vote(["yes", "yes", "yes", "yes"]);
    const th = g.state.end?.benchmarks.theory;
    expect(th?.round).toBe(1);
    expect(th?.offers).toHaveLength(1);
    // The seating that gives everyone 7: each one's main wish.
    const d = g.state.deal;
    const order = th?.offers[0]?.map((x) => EXECUTIVES.indexOf(x)) ?? [];
    const ring = [5, ...order];
    for (let i = 0; i < 5; i++) {
      const k = ring.indexOf(i);
      const w = d?.weights[i] ?? [];
      expect(
        (w[ring[(k + 5) % 6] as number] ?? 0) +
          (w[ring[(k + 1) % 6] as number] ?? 0),
      ).toBe(7);
    }
    expect(th?.expect).toEqual(["7", "7", "7", "7", "7"]);
    expect(th?.draws).toHaveLength(3);
  });
});

describe("what each reader sees", () => {
  const leaks = (text: string, deal: ExecState["deal"]) => [
    text.includes("compromise"),
    text.includes('"roles"'),
    text.includes('"draws"'),
    text.includes(deal?.seed ?? "no seed"),
  ];

  it("shows an assistant its own brief and nothing private of anyone else", () => {
    const g = match(
      quick("compromise"),
      seedWhere((d) => new Set(d).size === 3),
    );
    const briefs = players.map(
      (p) => view(g.state, g.events, p).you?.brief as string,
    );
    expect(new Set(briefs).size).toBe(5);
    players.forEach((p, i) => {
      const v = view(g.state, g.events, p);
      const text = JSON.stringify(v);
      expect(v.you?.executive).toBe(
        EXECUTIVES[executiveOf(g.state, p) as number],
      );
      expect(Object.keys(v.you?.weights ?? {})).toHaveLength(5);
      briefs.forEach((b, j) => {
        expect(text.includes(JSON.stringify(b).slice(1, -1))).toBe(i === j);
      });
      expect(leaks(text, g.state.deal)).toEqual([false, false, false, false]);
      // Only this round's proposer is named; later draws stay secret.
      const later = (g.state.deal?.draws ?? []).slice(1);
      expect(v.round?.proposer).toBe(
        EXECUTIVES[g.state.deal?.draws[0] as number],
      );
      expect(later.length).toBe(2);
    });
    const outsider = JSON.stringify(view(g.state, g.events, null));
    for (const b of briefs)
      expect(outsider.includes(JSON.stringify(b).slice(1, -1))).toBe(false);
    expect(outsider).not.toContain("weights");
    expect(view(g.state, g.events, null).you).toBeNull();
  });

  it("names the next deadline in every view", () => {
    const g = match(EXEC_VARIANTS.compromise as ExecVariant);
    const v = (at: number, p: string | null = null) =>
      view(g.state, g.events, p, { now: later(at) });
    expect(v(10).next_deadline).toEqual({
      at: later(180).toISOString(),
      what: expect.stringContaining("Filing opens"),
    });
    expect(v(200).next_deadline?.at).toBe(later(420).toISOString());
    expect(v(200).due).toBe(later(420).toISOString());
    g.file(200);
    expect(v(201, players[0]).next_deadline?.at).toBe(later(500).toISOString());
    expect(v(201).round?.proposal?.votes_close_at).toBe(
      later(500).toISOString(),
    );
  });

  it("shows everything once the match is over", () => {
    const g = match(quick("compromise"), "after");
    g.run(g.of("Avery"), { kind: "talk", text: "psst", to: ["Blake"] });
    g.file();
    g.vote(["yes", "yes", "yes", "yes"]);
    expect(g.state.phase).toBe("over");
    const v = view(g.state, g.events, null);
    expect(v.talk).toEqual([
      expect.objectContaining({ untrusted_text: "psst", to: ["Blake"] }),
    ]);
    expect(v.result?.configuration.name).toBe("compromise");
    expect(v.result?.draws).toHaveLength(3);
    for (const e of v.result?.executives ?? [])
      expect(e.brief).toBe(
        view(g.state, g.events.slice(0, 20), e.assistant).you?.brief,
      );
    expect(v.rounds[0]?.proposal).toHaveProperty("points");
    expect(v.result?.benchmarks.theory.round).toBe(1);
  });
});
