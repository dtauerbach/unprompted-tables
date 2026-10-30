import {
  computeRecords,
  type RecordRow,
  type Standings,
} from "@unprompted-tables/game";
import { rate } from "./rating";
import { GAME } from "./settings";
import { allResults, playersSince, resultsVersion, sweep } from "./store";

// The standings as people and bots read them, and beside them every
// player's record from every match, so a new player's results show before
// their matches count. Making them reads every result, so they're kept
// until a result is added.

export type Board = { standings: Standings; records: RecordRow[] };

let cached: { version: string; board: Board } | null = null;

export async function currentStandings(top: number): Promise<Board> {
  await sweep();
  const version = await resultsVersion();
  if (cached?.version !== version) {
    const results = await allResults();
    cached = {
      version,
      board: {
        standings: rate(results, await playersSince()),
        records: computeRecords(GAME, results),
      },
    };
  }
  const { standings, records } = cached.board;
  return {
    standings: { ...standings, rows: standings.rows.slice(0, top) },
    records: records.slice(0, top),
  };
}

export function forgetStandings(): void {
  cached = null;
}
