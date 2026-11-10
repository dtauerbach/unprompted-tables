import { feedSchema, LIMITS } from "@unprompted-tables/spectator";
import { describe, expect, it } from "vitest";
import { execFeed } from "./feed";
import {
  act,
  advance,
  apply,
  EXECUTIVES,
  type ExecAction,
  type ExecEvent,
  type ExecState,
  playerOf,
  replay,
  start,
  view,
} from "./game";
import {
  EXEC_VARIANTS,
  type ExecVariant,
  execFeedBytes,
  execVariantSchema,
} from "./variants";

// The spectator feed of the executive seating game. Players can read it,
// so while a match is live it must say nothing a public event doesn't: the
// tests here check that by playing the same match with and without private
// moves and asking for the same feed.

const TABLE = { name: "Dinner party", game: "dinner-party" };
const players = ["alice", "bobby", "carol", "david", "ellen"];
const T0 = new Date("2026-11-10T03:00:00.000Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const QUICK = { talk_min: 0, propose_by: 60, vote_seconds: 30 };
const quick = (config: string): ExecVariant => ({
  ...(EXEC_VARIANTS[config] as ExecVariant),
  clocks: { first: QUICK, later: QUICK },
});

function match(variant: ExecVariant, seed = "feed-seed") {
  let events = start(players, variant, T0, seed);
  let state = replay("m_abcdefghijkl", events);
  const g = {
    run(player: string, action: ExecAction, at: number) {
      const added = act(state, player, action, later(at));
      events = [...events, ...added];
      state = added.reduce(apply, state);
    },
    tick(at: number) {
      const added = advance(state, later(at));
      events = [...events, ...added];
      state = added.reduce(apply, state);
    },
    get state(): ExecState {
      return state;
    },
    get events(): ExecEvent[] {
      return events;
    },
    feed: () => feedSchema.parse(execFeed(state, events, TABLE)),
    of: (x: string) => playerOf(state, EXECUTIVES.indexOf(x)),
    proposer: () => playerOf(state, state.round?.proposer as number),
    voters: () =>
      players.filter(
        (p) => p !== playerOf(state, state.round?.proposer as number),
      ),
    file(at: number, seating = EXECUTIVES) {
      g.run(
        g.proposer(),
        {
          kind: "propose",
          round: state.round?.number as number,
          seating: [...seating],
        },
        at,
      );
    },
    vote(ballots: ("yes" | "no" | null)[], at: number) {
      const r = state.round?.number as number;
      g.voters().forEach((p, k) => {
        const b = ballots[k];
        if (b) g.run(p, { kind: "vote", round: r, ballot: b }, at);
      });
    },
  };
  return g;
}

const SECRET = "the-secret-plan-zq7";

describe("the live feed", () => {
  it("is the same with and without private messages and sealed ballots", () => {
    const quiet = match(quick("standoff"));
    const busy = match(quick("standoff"));
    for (const g of [quiet, busy])
      g.run(g.of("Avery"), { kind: "talk", text: "hi" }, 1);
    busy.run(
      busy.of("Blake"),
      { kind: "talk", text: SECRET, to: ["Casey"] },
      2,
    );
    for (const g of [quiet, busy]) g.file(3);
    busy.run(
      busy.of("Casey"),
      { kind: "talk", text: SECRET, to: ["Avery", "Blake"] },
      4,
    );
    // Three of the four ballots: the round stays open.
    busy.vote(["no", "yes", "no", null], 5);
    busy.run(
      busy.of("Emery"),
      { kind: "talk", text: SECRET, to: ["Devon"] },
      6,
    );
    expect(busy.state.round?.number).toBe(1);
    expect(busy.events.length).toBeGreaterThan(quiet.events.length + 5);
    expect(busy.feed()).toEqual(quiet.feed());
    const text = JSON.stringify(busy.feed());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("Private");
    // Each player's own view does show what's theirs.
    expect(
      view(busy.state, busy.events, busy.of("Casey")).talk.map(
        (t) => t.untrusted_text,
      ),
    ).toContain(SECRET);
  });

  it("names no brief, weight, configuration, role, seed or later proposer", () => {
    const g = match(quick("standoff"), "leaks");
    g.run(g.of("Avery"), { kind: "talk", text: "hello" }, 1);
    const f = g.feed();
    const text = JSON.stringify(f);
    const briefs = players.map(
      (p) => view(g.state, g.events, p).you?.brief as string,
    );
    for (const b of briefs)
      for (const line of b.split("\n"))
        expect(text).not.toContain(JSON.stringify(line).slice(1, -1));
    for (const word of ["standoff", "weights", "points)", "chairs", '"roles"'])
      expect(text).not.toContain(word);
    expect(text).not.toContain(g.state.deal?.seed as string);
    expect(f.timeline.filter((e) => e.text.startsWith("Round "))).toHaveLength(
      1,
    );
    expect(f.outcome).toBeNull();
    expect(f.match.status).toBe("live");
    expect(f.match.phase?.label).toContain("Round 1 of 3");
    expect(f.match.phase?.due).toBe(later(60).toISOString());
  });

  it("shows the filing at once and the ballots only when the round closes", () => {
    const g = match(quick("compromise"), "ballots");
    g.file(2);
    g.vote(["no", "yes", null, null], 3);
    let f = g.feed();
    expect(f.timeline.at(-1)?.text).toContain("Filed for round 1");
    expect(f.timeline.at(-1)?.by).toBe(
      `${EXECUTIVES[g.state.round?.proposer as number]?.toLowerCase()}-assistant`,
    );
    expect((f.board as { title: string }).title).toBe(
      "Round 1 proposal, voting open",
    );
    expect(JSON.stringify(f)).not.toMatch(/ (yes|no)\b,/);
    g.tick(32);
    f = g.feed();
    const votes = f.timeline.find((e) => e.text.startsWith("Round 1 votes"));
    expect(votes?.text).toMatch(/no, .*yes|yes, .*no/);
    expect(votes?.text).toContain("not cast");
    expect(
      f.timeline.some((e) => e.text === "Round 1 fails 2-1, 2 not cast."),
    ).toBe(true);
    expect((f.board as { title: string }).title).toBe(
      "Round 1 proposal, rejected 2-1, 2 not cast",
    );
    expect(f.timeline.at(-1)?.text).toMatch(/^Round 2 of 3\./);
  });

  it("keeps updated_at to what it shows", () => {
    const g = match(quick("compromise"), "updated");
    g.run(g.of("Avery"), { kind: "talk", text: "x", to: ["Blake"] }, 20);
    expect(g.feed().match.updated_at).toBe(T0.toISOString());
    g.run(g.of("Avery"), { kind: "talk", text: "y" }, 25);
    expect(g.feed().match.updated_at).toBe(later(25).toISOString());
  });
});

describe("the finished feed", () => {
  function played() {
    const g = match(quick("compromise"), "finished");
    g.run(g.of("Avery"), { kind: "talk", text: "open" }, 1);
    g.run(
      g.of("Avery"),
      { kind: "talk", text: SECRET, to: ["Blake", "Casey"] },
      2,
    );
    g.file(3);
    g.vote(["no", "no", null, null], 4);
    g.tick(33);
    g.file(34);
    g.vote(["yes", "yes", "yes", "yes"], 35);
    expect(g.state.phase).toBe("over");
    return g;
  }

  it("adds private messages, marked with their recipients", () => {
    const f = played().feed();
    const quiet = f.timeline.find((e) => e.text.includes(SECRET));
    expect(quiet?.kind).toBe("talk");
    expect(quiet?.by).toBe("avery-assistant");
    expect(quiet?.text).toBe(
      `(Private, to Blake's assistant and Casey's assistant) ${SECRET}`,
    );
    expect(f.match.status).toBe("over");
    expect(f.timeline.at(-1)?.text).toMatch(/^Agreed in round 2: Sage, /);
  });

  it("measures the deal in levels, against the theory", () => {
    const g = played();
    const f = g.feed();
    const o = f.outcome;
    expect(o?.measures.map((m) => m.label)).toEqual([
      "Agreed in round",
      "Yes votes",
      "Proposer's points",
      "Proposer's share of all points",
      "Total points",
      "Lowest executive's points",
      "Seatings better for some and worse for none",
      "Seatings some three would all rather have",
      "Seatings with a larger Nash product",
      "Messages sent in private",
      "Ballots not cast",
    ]);
    const m = (label: string) => o?.measures.find((x) => x.label === label);
    expect(m("Agreed in round")?.value).toBe(2);
    expect(m("Agreed in round")?.note).toBe(
      "Of 3. Theory without talk: round 1.",
    );
    expect(m("Yes votes")?.value).toBe(5);
    expect(m("Messages sent in private")?.value).toBe(0.5);
    expect(m("Ballots not cast")?.value).toBe(2);
    const points = g.state.end?.points as number[];
    expect(m("Total points")?.value).toBe(points.reduce((a, b) => a + b, 0));
    expect(m("Total points")?.note).toBe("Highest possible total: 35.");
    expect(o?.scores?.columns.map((c) => [c.key, c.label, c.format])).toEqual([
      ["points", "Points", "number"],
      ["share", "Share of best", "percent"],
      ["theory", "Theory, same draws", "number"],
      ["nash", "Nash seating", "number"],
      ["proposer", "Times proposer", "number"],
      ["yes", "Said yes", "number"],
    ]);
    // Share of best is points over the best that executive could get: 4 of
    // 10 is 40%, never measured from the worst.
    for (const [i, row] of (o?.scores?.rows ?? []).entries()) {
      expect(row.participant).toBe(`${EXECUTIVES[i]?.toLowerCase()}-assistant`);
      expect(row.values.points).toBe(points[i]);
      expect(row.values.share).toBe((points[i] as number) / 10);
      expect(row.values.theory).toBe(7);
      expect(row.values.nash).toBe(7);
    }
    expect(
      o?.scores?.rows.reduce((n, r) => n + (r.values.proposer ?? 0), 0),
    ).toBe(2);
    expect(o?.scores?.rows.reduce((n, r) => n + (r.values.yes ?? 0), 0)).toBe(
      4,
    );
  });

  it("reveals each brief, each round and the theory", () => {
    const g = played();
    const o = g.feed().outcome;
    expect(o?.reveals.map((r) => r.participant)).toEqual([
      "avery",
      "blake",
      "casey",
      "devon",
      "emery",
      `${EXECUTIVES[g.state.closed[0]?.proposer as number]?.toLowerCase()}-assistant`,
      `${EXECUTIVES[g.state.closed[1]?.proposer as number]?.toLowerCase()}-assistant`,
      "sage",
    ]);
    for (const r of o?.reveals ?? [])
      expect(r.text.length).toBeLessThanOrEqual(LIMITS.reveal);
    for (const p of players) {
      const brief = view(g.state, g.events.slice(0, 10), p).you?.brief ?? "";
      expect(o?.reveals.some((r) => r.text.startsWith(brief))).toBe(true);
    }
    const sage = o?.reveals.at(-1)?.text ?? "";
    expect(sage).toContain("Configuration: compromise (conflict level 1)");
    expect(sage).toContain("Proposer draws:");
    expect(sage).toContain("full information");
    expect(sage).toContain("Pareto frontier: 16 of 60");
    expect(o?.reveals[5]?.text).toContain("Failed 1-2, 2 not cast.");
  });

  it("shows no deal as points with no percentage", () => {
    const g = match(quick("standoff"), "nodeal");
    g.file(1);
    g.vote(["no", null, null, null], 2);
    g.tick(10_000);
    const f = g.feed();
    expect(g.state.end?.how).toBe("no_deal");
    expect(f.outcome?.measures.map((m) => m.label)).toEqual([
      "Rounds played",
      "Most yes votes on a proposal",
      "Round theory expected a deal",
      "Messages sent in private",
      "Ballots not cast",
    ]);
    expect(f.outcome?.measures[1]?.value).toBe(1);
    for (const row of f.outcome?.scores?.rows ?? []) {
      expect(row.values.points).toBe(-10);
      expect(row.values.share).toBeNull();
    }
    expect(f.outcome?.summary).toMatch(/^No deal after 3 rounds/);
    expect((f.board as { title: string }).title).toBe(
      "Round 1 proposal, rejected 1-1, 3 not cast",
    );
    expect(f.outcome?.reveals).toHaveLength(5 + 3 + 1);
  });

  it("fits watchers whole at its worst", () => {
    const v = EXEC_VARIANTS.standoff as ExecVariant;
    const g = match({ ...v, clocks: { first: QUICK, later: QUICK } }, "worst");
    // Every assistant sends every message at full length, in a script
    // that takes three bytes a character, privately to all four others.
    for (const p of players) {
      const me = EXECUTIVES[g.state.cast[players.indexOf(p)] as number];
      const to = EXECUTIVES.filter((x) => x !== me);
      for (let k = 0; k < v.messages_per_assistant; k++)
        g.run(p, { kind: "talk", text: "語".repeat(v.message_chars), to }, 1);
    }
    for (let r = 0; r < v.rounds; r++) {
      g.file(1 + r * 31);
      g.vote(["no", "no", "no", "no"], 2 + r * 31);
    }
    expect(g.state.phase).toBe("over");
    const f = g.feed();
    expect(f.timeline.length).toBeLessThanOrEqual(LIMITS.timeline);
    expect(f.timeline.filter((e) => e.kind === "talk")).toHaveLength(
      5 * v.messages_per_assistant,
    );
    const bytes = Buffer.byteLength(JSON.stringify(f));
    expect(bytes).toBeLessThanOrEqual(execFeedBytes(v));
    expect(execFeedBytes(v)).toBeLessThanOrEqual(LIMITS.bytes);
  });

  it("refuses a variant whose feed would be too big", () => {
    const r = execVariantSchema.safeParse({
      ...(EXEC_VARIANTS.standoff as ExecVariant),
      messages_per_assistant: 200,
      message_chars: 1000,
    });
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      "a full match's feed would be too big for watchers",
    ]);
  });
});
