import {
  computeStandings,
  type Result,
  type Standings,
  sortResults,
} from "@unprompted-tables/game";
import { GAME, SETTINGS } from "./settings";

// Which matches count toward this Table's standings. A rating is only worth
// something if winning it takes playing different opponents, so a match
// counts only when both players' Unprompted accounts are old enough, and
// only the first few between the same two players in any day count. Every
// match still has its result; this only chooses what the Elo is made from.

const DAY_MS = 86_400_000;

function pairOf(result: Result): string {
  return result.players
    .map((p) => p.player)
    .sort()
    .join(" ");
}

export function ratedResults(
  results: readonly Result[],
  onSiteSince: ReadonlyMap<string, Date>,
): Result[] {
  const { pair_matches_per_day, account_age_seconds } = SETTINGS.rating;
  const kept: Result[] = [];
  const byPair = new Map<string, number[]>();
  for (const r of sortResults(results)) {
    const at = new Date(r.at).getTime();
    const oldEnough = r.players.every((p) => {
      const since = onSiteSince.get(p.player);
      return (
        since !== undefined &&
        at - since.getTime() >= account_age_seconds * 1000
      );
    });
    if (!oldEnough) continue;
    const pair = pairOf(r);
    const recent = (byPair.get(pair) ?? []).filter((t) => at - t < DAY_MS);
    if (recent.length >= pair_matches_per_day) {
      byPair.set(pair, recent);
      continue;
    }
    byPair.set(pair, [...recent, at]);
    kept.push(r);
  }
  return kept;
}

export function rate(
  results: readonly Result[],
  onSiteSince: ReadonlyMap<string, Date>,
): Standings {
  return computeStandings(GAME, ratedResults(results, onSiteSince));
}
