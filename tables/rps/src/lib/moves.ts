import { SEAL_RE } from "@unprompted-tables/game";
import { ApiError, consume } from "@unprompted-tables/server";
import { z } from "zod";
import { moveRules } from "./limits";
import {
  apply,
  commit,
  type MatchEvent,
  type MatchState,
  RuleError,
  reveal,
  type Seat,
} from "./match";
import { MOVES } from "./rules";
import { type MatchView, view, withMatch } from "./store";

// A player's moves, from a request to the match's rules and back. The rules
// decide; this only finds the player's seat and turns a refusal into HTTP.

const round = z.number().int().min(1).max(1000);

export const commitSchema = z.strictObject({
  round,
  seal: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SEAL_RE, "64 hex digits: the sha256 of your sealed move"),
});

export const revealSchema = z.strictObject({
  round,
  move: z.enum(MOVES),
  salt: z.string().min(1).max(100),
});

const STATUS: Record<RuleError["code"], number> = {
  match_over: 409,
  wrong_round: 409,
  wrong_phase: 409,
  already_committed: 409,
  already_revealed: 409,
  bad_reveal: 400,
};

function seatOf(state: MatchState, player: string): Seat {
  const seat = state.players.indexOf(player);
  if (seat !== 0 && seat !== 1)
    throw new ApiError(403, "not_seated", "You aren't playing in this match.");
  return seat;
}

async function move(
  id: string,
  player: string,
  act: (state: MatchState, seat: Seat, at: Date) => MatchEvent[],
): Promise<MatchView> {
  return withMatch(id, async (state, events, tx, at) => {
    const seat = seatOf(state, player);
    let added: MatchEvent[];
    try {
      added = act(state, seat, at);
    } catch (e) {
      if (e instanceof RuleError)
        throw new ApiError(STATUS[e.code], e.code, e.message);
      throw e;
    }
    // Counted after the rules, so only a move that's taken counts.
    await consume(tx, moveRules(player));
    let after = state;
    for (const e of added) after = apply(after, e);
    return { events: added, value: view(after, [...events, ...added]) };
  });
}

export function commitMove(
  id: string,
  player: string,
  input: z.output<typeof commitSchema>,
): Promise<MatchView> {
  return move(id, player, (s, seat, at) =>
    commit(s, seat, input.round, input.seal, at),
  );
}

export function revealMove(
  id: string,
  player: string,
  input: z.output<typeof revealSchema>,
): Promise<MatchView> {
  return move(id, player, (s, seat, at) =>
    reveal(s, seat, input.round, input.move, input.salt, at),
  );
}
