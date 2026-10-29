import { opens, phaseDue, SALT_RE } from "@unprompted-tables/game";
import { isMove, type Move, play } from "./rules";
import { GAME, SETTINGS } from "./settings";

// One match, as the events that happened in it. Its state is never stored:
// it's replayed from the events, and every action only adds events. The
// clock runs whether or not anyone is looking: a phase that ran out is
// closed as of its deadline, the next time anyone touches the match.
//
// A round: both players seal a move, then both reveal it. A player who
// misses a phase loses the round; if both miss it, the match is abandoned
// and has no result.

export type Seat = 0 | 1;
export type Phase = "commit" | "reveal";
export type Outcome = "won" | "drawn" | "abandoned";

export type MatchEvent =
  | { kind: "start"; at: string; players: [string, string] }
  | { kind: "commit"; at: string; round: number; seat: Seat; seal: string }
  | {
      kind: "reveal";
      at: string;
      round: number;
      seat: Seat;
      move: Move;
      salt: string;
    }
  | { kind: "timeout"; at: string; round: number; phase: Phase; missed: Seat[] }
  | { kind: "round"; at: string; round: number; winner: Seat | null }
  | { kind: "end"; at: string; outcome: Outcome; winner: Seat | null };

export type MatchState = {
  id: string;
  players: [string, string];
  round: number;
  phase: Phase | "over";
  opened: Date;
  seals: [string | null, string | null];
  moves: [Move | null, Move | null];
  wins: [number, number];
  outcome: Outcome | null;
  winner: Seat | null;
};

export class RuleError extends Error {
  constructor(
    readonly code:
      | "match_over"
      | "wrong_round"
      | "wrong_phase"
      | "already_committed"
      | "already_revealed"
      | "bad_reveal",
    message: string,
  ) {
    super(message);
  }
}

const SEATS: Seat[] = [0, 1];

// What a player seals: its move, bound to this game, match, round and
// player, so a seal can't be reused anywhere else or copied by an opponent.
export function sealFields(
  match: string,
  round: number,
  player: string,
  move: string,
  salt: string,
): string[] {
  return [GAME, match, String(round), player, move, salt];
}

export function apply(s: MatchState | null, e: MatchEvent): MatchState {
  if (e.kind === "start") {
    if (s) throw new Error("a match starts once");
    return {
      id: "",
      players: e.players,
      round: 1,
      phase: "commit",
      opened: new Date(e.at),
      seals: [null, null],
      moves: [null, null],
      wins: [0, 0],
      outcome: null,
      winner: null,
    };
  }
  if (!s) throw new Error("a match starts with its start event");
  switch (e.kind) {
    case "commit": {
      const seals: MatchState["seals"] = [...s.seals];
      seals[e.seat] = e.seal;
      const both = seals.every(Boolean);
      return {
        ...s,
        seals,
        ...(both ? { phase: "reveal", opened: new Date(e.at) } : {}),
      };
    }
    case "reveal": {
      const moves: MatchState["moves"] = [...s.moves];
      moves[e.seat] = e.move;
      return { ...s, moves };
    }
    case "timeout":
      return s;
    case "round": {
      const wins: MatchState["wins"] = [...s.wins];
      if (e.winner !== null) wins[e.winner] += 1;
      return {
        ...s,
        wins,
        round: s.round + 1,
        phase: "commit",
        opened: new Date(e.at),
        seals: [null, null],
        moves: [null, null],
      };
    }
    case "end":
      return { ...s, phase: "over", outcome: e.outcome, winner: e.winner };
  }
}

export function replay(id: string, events: readonly MatchEvent[]): MatchState {
  let s: MatchState | null = null;
  for (const e of events) s = apply(s, e);
  if (!s) throw new Error(`match ${id} has no events`);
  return { ...s, id };
}

export function due(s: MatchState): Date | null {
  if (s.phase === "over") return null;
  return phaseDue(SETTINGS.clock, s.phase, s.opened);
}

// The match ends after a round once someone has enough round wins, or once
// the last round is played.
function endAfterRound(s: MatchState, at: string): MatchEvent[] {
  const [a, b] = s.wins;
  for (const seat of SEATS)
    if (s.wins[seat] >= SETTINGS.rounds_to_win)
      return [{ kind: "end", at, outcome: "won", winner: seat }];
  if (s.round > SETTINGS.max_rounds) {
    if (a === b) return [{ kind: "end", at, outcome: "drawn", winner: null }];
    return [{ kind: "end", at, outcome: "won", winner: a > b ? 0 : 1 }];
  }
  return [];
}

// Adds each event to the list and the state, and ends the match if a round
// event finished it.
function emit(s: MatchState, out: MatchEvent[], e: MatchEvent): MatchState {
  out.push(e);
  let next = apply(s, e);
  if (e.kind === "round") {
    for (const end of endAfterRound(next, e.at)) {
      out.push(end);
      next = apply(next, end);
    }
  }
  return next;
}

// Closes every phase whose time ran out by now, each as of its deadline.
export function advance(s: MatchState, now: Date): MatchEvent[] {
  const out: MatchEvent[] = [];
  let cur = s;
  for (let d = due(cur); d && d <= now && cur.phase !== "over"; d = due(cur)) {
    const phase = cur.phase as Phase;
    const at = d.toISOString();
    const done = phase === "commit" ? cur.seals : cur.moves;
    const missed = SEATS.filter((seat) => done[seat] === null);
    cur = emit(cur, out, {
      kind: "timeout",
      at,
      round: cur.round,
      phase,
      missed,
    });
    if (missed.length === 2)
      cur = emit(cur, out, {
        kind: "end",
        at,
        outcome: "abandoned",
        winner: null,
      });
    else
      cur = emit(cur, out, {
        kind: "round",
        at,
        round: cur.round,
        winner: missed[0] === 0 ? 1 : 0,
      });
  }
  return out;
}

function check(s: MatchState, round: number, phase: Phase): void {
  if (s.phase === "over")
    throw new RuleError("match_over", "This match is over.");
  if (round !== s.round)
    throw new RuleError(
      "wrong_round",
      `This match is on round ${s.round}, not ${round}.`,
    );
  if (s.phase !== phase)
    throw new RuleError(
      "wrong_phase",
      s.phase === "commit"
        ? "It's time to commit a seal, not to reveal."
        : "Both seals are in: it's time to reveal, not to commit.",
    );
}

// The caller advances the match first, so a seal after the deadline is
// refused as the wrong round or phase.
export function commit(
  s: MatchState,
  seat: Seat,
  round: number,
  seal: string,
  now: Date,
): MatchEvent[] {
  check(s, round, "commit");
  if (s.seals[seat] !== null)
    throw new RuleError(
      "already_committed",
      "You've already sealed a move this round, and a seal can't change.",
    );
  return [{ kind: "commit", at: now.toISOString(), round, seat, seal }];
}

export function reveal(
  s: MatchState,
  seat: Seat,
  round: number,
  move: string,
  salt: string,
  now: Date,
): MatchEvent[] {
  check(s, round, "reveal");
  if (s.moves[seat] !== null)
    throw new RuleError(
      "already_revealed",
      "You've already revealed your move this round.",
    );
  const seal = s.seals[seat] as string;
  if (
    !isMove(move) ||
    !SALT_RE.test(salt) ||
    !opens(seal, sealFields(s.id, round, s.players[seat], move, salt))
  )
    throw new RuleError(
      "bad_reveal",
      "That move and salt don't open your seal. Send exactly the move and salt you sealed.",
    );
  const at = now.toISOString();
  const out: MatchEvent[] = [];
  let cur = emit(s, out, { kind: "reveal", at, round, seat, move, salt });
  const [a, b] = cur.moves;
  if (a && b) {
    const p = play(a, b);
    cur = emit(cur, out, {
      kind: "round",
      at,
      round,
      winner: p === 0 ? null : p === 1 ? 0 : 1,
    });
  }
  return out;
}

// Places for the library's result format, or null if the match has none.
export function places(
  s: MatchState,
): { player: string; place: number }[] | null {
  if (s.outcome === "won" && s.winner !== null)
    return s.players.map((player, seat) => ({
      player,
      place: seat === s.winner ? 1 : 2,
    }));
  if (s.outcome === "drawn")
    return s.players.map((player) => ({ player, place: 1 }));
  return null;
}
