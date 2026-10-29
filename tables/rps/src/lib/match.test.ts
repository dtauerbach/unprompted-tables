import { sealOf } from "@unprompted-tables/game";
import { describe, expect, it } from "vitest";
import {
  advance,
  apply,
  commit,
  due,
  type MatchEvent,
  type MatchState,
  places,
  RuleError,
  replay,
  reveal,
  type Seat,
  sealFields,
} from "./match";
import { play } from "./rules";
import { COMMIT_SECONDS, REVEAL_SECONDS, SETTINGS } from "./settings";

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000);
const SALT = ["salt-for-ruby-0001", "salt-for-jade-0001"];
const COMMIT = COMMIT_SECONDS;
const REVEAL = REVEAL_SECONDS;

function start(): { s: MatchState; log: MatchEvent[] } {
  const log: MatchEvent[] = [
    { kind: "start", at: at(0).toISOString(), players: ["ruby", "jade"] },
  ];
  return { s: replay("m_test", log), log };
}

function sealFor(s: MatchState, seat: Seat, move: string, round = s.round) {
  return sealOf(
    sealFields(s.id, round, s.players[seat], move, SALT[seat] as string),
  );
}

// Applies events to both the state and the log, as the store does.
function take(
  m: { s: MatchState; log: MatchEvent[] },
  events: MatchEvent[],
): void {
  for (const e of events) {
    m.s = apply(m.s, e);
    m.log.push(e);
  }
}

function playRound(
  m: { s: MatchState; log: MatchEvent[] },
  a: string,
  b: string,
  t: number,
) {
  const r = m.s.round;
  take(m, commit(m.s, 0, r, sealFor(m.s, 0, a), at(t)));
  take(m, commit(m.s, 1, r, sealFor(m.s, 1, b), at(t + 1)));
  take(m, reveal(m.s, 0, r, a, SALT[0] as string, at(t + 2)));
  take(m, reveal(m.s, 1, r, b, SALT[1] as string, at(t + 3)));
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuleError) return e.code;
    throw e;
  }
  throw new Error("no error");
}

describe("rock paper scissors", () => {
  it("knows which move beats which", () => {
    expect(play("rock", "scissors")).toBe(1);
    expect(play("scissors", "paper")).toBe(1);
    expect(play("paper", "rock")).toBe(1);
    expect(play("rock", "paper")).toBe(-1);
    expect(play("paper", "paper")).toBe(0);
  });
});

describe("a match", () => {
  it("is won by the first to two round wins, and draws don't count", () => {
    const m = start();
    playRound(m, "rock", "scissors", 1);
    playRound(m, "rock", "rock", 10);
    expect(m.s.wins).toEqual([1, 0]);
    expect(m.s.round).toBe(3);
    playRound(m, "paper", "scissors", 20);
    playRound(m, "paper", "rock", 30);
    expect(m.s.phase).toBe("over");
    expect(m.s).toMatchObject({ outcome: "won", winner: 0, wins: [2, 1] });
    expect(places(m.s)).toEqual([
      { player: "ruby", place: 1 },
      { player: "jade", place: 2 },
    ]);
    // The log replays to the same state.
    expect(replay("m_test", m.log)).toEqual(m.s);
  });

  it("ends level after the last round as a draw", () => {
    const m = start();
    for (let r = 0; r < SETTINGS.max_rounds; r++)
      playRound(m, "rock", "rock", 1 + r * 10);
    expect(m.s).toMatchObject({ phase: "over", outcome: "drawn" });
    expect(places(m.s)).toEqual([
      { player: "ruby", place: 1 },
      { player: "jade", place: 1 },
    ]);
  });

  it("gives the last round to whoever has more wins", () => {
    const m = start();
    playRound(m, "rock", "scissors", 1);
    for (let r = 1; r < SETTINGS.max_rounds; r++)
      playRound(m, "rock", "rock", 1 + r * 10);
    expect(m.s).toMatchObject({ outcome: "won", winner: 0, wins: [1, 0] });
  });

  it("opens the reveal phase when both seals are in", () => {
    const m = start();
    take(m, commit(m.s, 1, 1, sealFor(m.s, 1, "rock"), at(5)));
    expect(m.s.phase).toBe("commit");
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(9)));
    expect(m.s.phase).toBe("reveal");
    expect(due(m.s)).toEqual(at(9 + REVEAL));
  });
});

describe("the clock", () => {
  it("gives the round to the player who sealed when the other didn't", () => {
    const m = start();
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(5)));
    expect(advance(m.s, at(COMMIT - 1))).toEqual([]);
    take(m, advance(m.s, at(COMMIT)));
    expect(m.s.wins).toEqual([1, 0]);
    expect(m.log.at(-2)).toMatchObject({
      kind: "timeout",
      phase: "commit",
      missed: [1],
      at: at(COMMIT).toISOString(),
    });
    // The next round opened at the deadline, not when someone looked.
    expect(due(m.s)).toEqual(at(COMMIT * 2));
  });

  it("gives the round away when a player won't reveal", () => {
    const m = start();
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(1)));
    take(m, commit(m.s, 1, 1, sealFor(m.s, 1, "paper"), at(2)));
    // Ruby reveals, and jade stalls instead of revealing.
    take(m, reveal(m.s, 0, 1, "rock", SALT[0] as string, at(3)));
    take(m, advance(m.s, at(2 + REVEAL)));
    expect(m.s.wins).toEqual([1, 0]);
  });

  it("abandons a match nobody plays, with no result", () => {
    const m = start();
    take(m, advance(m.s, at(COMMIT)));
    expect(m.s).toMatchObject({ phase: "over", outcome: "abandoned" });
    expect(places(m.s)).toBeNull();
  });

  it("closes every phase that ran out, each at its own deadline", () => {
    const m = start();
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(1)));
    // A day later: round 1 to ruby, then round 2 found both missing.
    take(m, advance(m.s, at(86_400)));
    expect(m.s).toMatchObject({ outcome: "abandoned", wins: [1, 0] });
    const ends = m.log.filter((e) => e.kind === "timeout").map((e) => e.at);
    expect(ends).toEqual([
      at(COMMIT).toISOString(),
      at(COMMIT * 2).toISOString(),
    ]);
    expect(advance(m.s, at(200_000))).toEqual([]);
  });

  it("can win a match on timeouts alone", () => {
    const m = start();
    for (let r = 0; r < SETTINGS.rounds_to_win; r++) {
      take(m, commit(m.s, 1, m.s.round, sealFor(m.s, 1, "rock"), m.s.opened));
      take(m, advance(m.s, due(m.s) as Date));
    }
    expect(m.s).toMatchObject({ outcome: "won", winner: 1 });
  });
});

describe("cheating", () => {
  it("refuses a second seal, which would let a player change its move", () => {
    const m = start();
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(1)));
    expect(code(() => commit(m.s, 0, 1, sealFor(m.s, 0, "paper"), at(2)))).toBe(
      "already_committed",
    );
  });

  it("refuses to reveal before both seals are in", () => {
    const m = start();
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(1)));
    expect(
      code(() => reveal(m.s, 0, 1, "rock", SALT[0] as string, at(2))),
    ).toBe("wrong_phase");
  });

  it("refuses a reveal that doesn't open the seal", () => {
    const m = start();
    take(m, commit(m.s, 0, 1, sealFor(m.s, 0, "rock"), at(1)));
    take(m, commit(m.s, 1, 1, sealFor(m.s, 1, "rock"), at(2)));
    for (const [move, salt] of [
      ["paper", SALT[0]],
      ["rock", "another-salt-0001"],
      ["lizard", SALT[0]],
      ["rock", "short"],
    ])
      expect(
        code(() => reveal(m.s, 0, 1, move as string, salt as string, at(3))),
      ).toBe("bad_reveal");
    // A wrong try changes nothing: the right one still works.
    take(m, reveal(m.s, 0, 1, "rock", SALT[0] as string, at(4)));
    expect(m.s.moves[0]).toBe("rock");
    expect(
      code(() => reveal(m.s, 0, 1, "rock", SALT[0] as string, at(5))),
    ).toBe("already_revealed");
  });

  it("makes a copied seal worthless", () => {
    const m = start();
    const rubys = sealFor(m.s, 0, "rock");
    take(m, commit(m.s, 0, 1, rubys, at(1)));
    // Jade copies ruby's seal, hoping to reveal whatever ruby reveals.
    take(m, commit(m.s, 1, 1, rubys, at(2)));
    take(m, reveal(m.s, 0, 1, "rock", SALT[0] as string, at(3)));
    expect(
      code(() => reveal(m.s, 1, 1, "rock", SALT[0] as string, at(4))),
    ).toBe("bad_reveal");
    take(m, advance(m.s, at(2 + REVEAL)));
    expect(m.s.wins).toEqual([1, 0]);
  });

  it("won't take last round's seal, or a move for another round", () => {
    const m = start();
    playRound(m, "rock", "scissors", 1);
    const old = sealFor(m.s, 1, "rock", 1);
    take(m, commit(m.s, 1, 2, old, at(10)));
    take(m, commit(m.s, 0, 2, sealFor(m.s, 0, "rock"), at(11)));
    // Last round's seal was bound to round 1, so it opens nothing in round 2.
    expect(
      code(() => reveal(m.s, 1, 2, "rock", SALT[1] as string, at(12))),
    ).toBe("bad_reveal");
    expect(
      code(() => reveal(m.s, 0, 1, "rock", SALT[0] as string, at(12))),
    ).toBe("wrong_round");
    expect(code(() => commit(m.s, 0, 3, "a".repeat(64), at(12)))).toBe(
      "wrong_round",
    );
  });

  it("refuses everything once the match is over", () => {
    const m = start();
    take(m, advance(m.s, at(COMMIT)));
    expect(code(() => commit(m.s, 0, 1, "a".repeat(64), at(70)))).toBe(
      "match_over",
    );
    expect(code(() => reveal(m.s, 0, 1, "rock", "x".repeat(16), at(70)))).toBe(
      "match_over",
    );
  });
});
