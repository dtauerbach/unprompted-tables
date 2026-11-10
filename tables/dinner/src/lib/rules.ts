import { ApiError } from "@unprompted-tables/server";
import * as exec from "./exec/game";
import * as party from "./match";
import { type AnyVariant, isExecVariant, type Variant } from "./variants";

// Which game a match plays is fixed by its start event: rules_version 1 is
// the first dinner party, kept so old matches still replay and render, and
// rules_version 2 is the executive seating game every new match plays. The
// store, the routes and the feed go through here and never need to know.

export type AnyEvent = party.MatchEvent | exec.ExecEvent;
export type AnyState = party.MatchState | exec.ExecState;
export type AnyAction =
  | { kind: "talk"; text: string; to?: string[] }
  | { kind: "propose"; seating: string[]; round?: number }
  | { kind: "back"; proposal: string | null }
  | { kind: "vote"; round: number; ballot: "yes" | "no" };

export const isExec = (s: AnyState): s is exec.ExecState =>
  s.rules_version === 2;

export function replay(id: string, events: AnyEvent[]): AnyState {
  const first = events[0]?.body;
  if (first?.kind === "start" && first.rules_version === 2)
    return exec.replay(id, events as exec.ExecEvent[]);
  return party.replay(id, events as party.MatchEvent[]);
}

export function apply(s: AnyState, e: AnyEvent): AnyState {
  return isExec(s)
    ? exec.apply(s, e as exec.ExecEvent)
    : party.apply(s, e as party.MatchEvent);
}

export function fold(s: AnyState, events: AnyEvent[]): AnyState {
  return events.reduce(apply, s);
}

export function advance(s: AnyState, now: Date): AnyEvent[] {
  return isExec(s) ? exec.advance(s, now) : party.advance(s, now);
}

export function due(s: AnyState): Date | null {
  return isExec(s) ? exec.due(s) : party.due(s);
}

export function start(
  players: string[],
  variant: AnyVariant,
  at: Date,
  seed?: string,
): AnyEvent[] {
  return isExecVariant(variant)
    ? exec.start(players, variant, at, seed)
    : party.start(players, variant as Variant, at, seed);
}

export function act(
  s: AnyState,
  player: string,
  action: AnyAction,
  now: Date,
): AnyEvent[] {
  if (isExec(s)) {
    if (action.kind === "back")
      throw new ApiError(
        400,
        "unknown_action",
        'This game has no "back". Vote with {"kind": "vote", "round": n, "ballot": "yes" or "no"}.',
      );
    return exec.act(s, player, action, now);
  }
  if (action.kind === "vote" || (action.kind === "talk" && action.to))
    throw new ApiError(
      400,
      "unknown_action",
      "This party has no votes or private talk: talk, propose or back.",
    );
  return party.act(s, player, action as party.Action, now);
}

export function view(
  s: AnyState,
  events: AnyEvent[],
  player: string | null,
  opts: { now?: Date; ask?: string[] } = {},
) {
  if (isExec(s)) return exec.view(s, events as exec.ExecEvent[], player, opts);
  if (opts.ask)
    throw new ApiError(
      400,
      "unknown_question",
      "This party doesn't answer seating questions; your brief has the numbers.",
    );
  return party.view(s, events as party.MatchEvent[], player);
}

// The row kept in results when a match ends.
export function resultOf(game: string, id: string, s: AnyState): unknown {
  if (!s.end) return null;
  if (isExec(s)) {
    const end = s.end;
    return {
      game,
      rules_version: 2,
      match: id,
      at: end.at,
      how: end.how,
      round: end.round,
      seating: end.seating,
      configuration: end.deal.config,
      rule: s.rules.rule,
      executives: exec.EXECUTIVES.map((executive, i) => ({
        executive,
        player: exec.playerOf(s, i),
        points: end.points[i],
        best: end.benchmarks.best[i],
        drawn: s.closed.filter((r) => r.proposer === i).length,
      })),
      theory: {
        round: end.benchmarks.theory.round,
        expect: end.benchmarks.theory.expect,
      },
      ballots_not_cast: s.closed.reduce(
        (n, r) =>
          n +
          (r.filing
            ? r.ballots.filter((b, i) => b === null && i !== r.proposer).length
            : 0),
        0,
      ),
    };
  }
  const end = s.end;
  return {
    game,
    match: id,
    at: end.at,
    how: end.how,
    seating: end.seating,
    guests: s.guests.map((guest, i) => ({
      guest,
      player: s.players[i],
      score: end.report.scores[i],
      satisfaction: end.report.satisfaction[i],
    })),
    value_captured: end.report.value_captured,
    worst_off: end.report.worst_off,
  };
}
