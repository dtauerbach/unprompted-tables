import { ApiError } from "@unprompted-tables/server";
import * as exec from "./exec/game";
import * as floor from "./floor/game";
import * as party from "./match";
import {
  type AnyVariant,
  isExecVariant,
  isFloorVariant,
  type Variant,
} from "./variants";

// Which game a match plays is fixed by its start event: rules_version 1 is
// the first dinner party and 2 the three-round executive game, both kept so
// their matches still replay and render; rules_version 3 is the open floor
// every new match plays. The store, the routes and the feed go through here
// and never need to know.

export type AnyEvent = party.MatchEvent | exec.ExecEvent | floor.FloorEvent;
export type AnyState = party.MatchState | exec.ExecState | floor.FloorState;
export type AnyAction =
  | { kind: "talk"; text: string; to?: string[] }
  | { kind: "propose"; seating: string[]; round?: number }
  | { kind: "back"; proposal: string | null }
  | { kind: "vote"; round?: number; motion?: number; ballot: "yes" | "no" }
  | { kind: "motion"; seating: string[] }
  | { kind: "name"; executive: string; dislikes: string };

export type GameKind = "party" | "exec" | "floor";

export const isExec = (s: AnyState): s is exec.ExecState =>
  s.rules_version === 2;
export const isFloor = (s: AnyState): s is floor.FloorState =>
  s.rules_version === 3;
export const kindOf = (s: AnyState): GameKind =>
  isFloor(s) ? "floor" : isExec(s) ? "exec" : "party";

export function replay(id: string, events: AnyEvent[]): AnyState {
  const first = events[0]?.body;
  if (first?.kind === "start" && first.rules_version === 3)
    return floor.replay(id, events as floor.FloorEvent[]);
  if (first?.kind === "start" && first.rules_version === 2)
    return exec.replay(id, events as exec.ExecEvent[]);
  return party.replay(id, events as party.MatchEvent[]);
}

export function apply(s: AnyState, e: AnyEvent): AnyState {
  if (isFloor(s)) return floor.apply(s, e as floor.FloorEvent);
  return isExec(s)
    ? exec.apply(s, e as exec.ExecEvent)
    : party.apply(s, e as party.MatchEvent);
}

export function fold(s: AnyState, events: AnyEvent[]): AnyState {
  return events.reduce(apply, s);
}

export function advance(s: AnyState, now: Date): AnyEvent[] {
  if (isFloor(s)) return floor.advance(s, now);
  return isExec(s) ? exec.advance(s, now) : party.advance(s, now);
}

// When the clock next changes the match. For the open floor this is the
// hidden moment dinner comes, so it's for the store's schedule alone and
// never shown: views and feeds give the public due.
export function due(s: AnyState): Date | null {
  if (isFloor(s)) return floor.due(s);
  return isExec(s) ? exec.due(s) : party.due(s);
}

export function start(
  players: string[],
  variant: AnyVariant,
  at: Date,
  seed?: string,
): AnyEvent[] {
  if (isFloorVariant(variant)) return floor.start(players, variant, at, seed);
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
  if (isFloor(s)) {
    if (action.kind === "propose" || action.kind === "back")
      throw new ApiError(
        400,
        "unknown_action",
        'This game has no "propose" or "back". Move a seating with {"kind": "motion", "seating": [...]} and vote with {"kind": "vote", "motion": n, "ballot": "yes" or "no"}.',
      );
    return floor.act(s, player, action, now);
  }
  if (isExec(s)) {
    if (
      action.kind === "back" ||
      action.kind === "motion" ||
      action.kind === "name"
    )
      throw new ApiError(
        400,
        "unknown_action",
        'This match has no such move. Propose in your round and vote with {"kind": "vote", "round": n, "ballot": "yes" or "no"}.',
      );
    if (action.kind === "vote" && action.round === undefined)
      throw new ApiError(
        400,
        "invalid_action",
        'Say which round: {"kind": "vote", "round": n, "ballot": "yes" or "no"}.',
      );
    return exec.act(s, player, action as exec.ExecAction, now);
  }
  if (
    action.kind === "vote" ||
    action.kind === "motion" ||
    action.kind === "name" ||
    (action.kind === "talk" && action.to)
  )
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
  if (isFloor(s))
    return floor.view(s, events as floor.FloorEvent[], player, opts);
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
  if (isFloor(s)) {
    const end = s.end;
    if (!end) return null;
    return {
      game,
      rules_version: 3,
      match: id,
      at: end.at,
      how: end.how,
      motion: end.motion,
      seating: end.seating,
      variant: end.deal.variant,
      level: end.deal.level,
      motions: s.motions.length,
      passed: s.history.length,
      void: end.void,
      executives: floor.EXECUTIVES.map((executive, i) => ({
        executive,
        player: floor.playerOf(s, i),
        seating_points: end.seating_points[i],
        naming_points: end.naming_points[i],
        points: end.points[i],
        exposed: end.exposed.includes(executive),
        moved: s.motions.filter((m) => m.mover === i).length,
      })),
    };
  }
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
      variant: end.deal.variant,
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
    variant: s.variant.name,
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
