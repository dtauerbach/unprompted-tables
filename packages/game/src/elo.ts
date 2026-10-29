import type { Result } from "./result";

// Elo, generalised to any number of players by treating a match as every
// pair of its players meeting once: finishing above someone counts as a win
// against them, sharing a place as a draw. K is split across the pairs so a
// match moves a player's rating as much as one two-player game would.

export const ELO_K = 32;
export const ELO_START = 1500;

export function expected(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

// The change in each player's rating from one match, using everyone's
// rating from before it. The changes always sum to zero.
export function eloChanges(
  result: Result,
  ratings: ReadonlyMap<string, number>,
  k = ELO_K,
): Map<string, number> {
  const { players } = result;
  const share = k / (players.length - 1);
  const changes = new Map<string, number>();
  for (const me of players) {
    const mine = ratings.get(me.player) ?? ELO_START;
    let delta = 0;
    for (const them of players) {
      if (them === me) continue;
      const theirs = ratings.get(them.player) ?? ELO_START;
      const score =
        me.place < them.place ? 1 : me.place === them.place ? 0.5 : 0;
      delta += score - expected(mine, theirs);
    }
    changes.set(me.player, share * delta);
  }
  return changes;
}
