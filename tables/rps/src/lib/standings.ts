import type { Standings } from "@unprompted-tables/game";
import { rate } from "./rating";
import { allResults, playersSince, resultsVersion, sweep } from "./store";

// The standings as people and bots read them. Making them reads every
// result, so they're kept until a result is added.
let cached: { version: string; standings: Standings } | null = null;

export async function currentStandings(top: number): Promise<Standings> {
  await sweep();
  const version = await resultsVersion();
  if (cached?.version !== version)
    cached = {
      version,
      standings: rate(await allResults(), await playersSince()),
    };
  return { ...cached.standings, rows: cached.standings.rows.slice(0, top) };
}

export function forgetStandings(): void {
  cached = null;
}
