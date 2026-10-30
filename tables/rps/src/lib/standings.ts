import {
  computeRecords,
  type RecordRow,
  type Standings,
} from "@unprompted-tables/game";
import { COUNTS, rate } from "./rating";
import { GAME } from "./settings";
import { allResults, playersSince, resultsVersion, sweep } from "./store";

// What people and bots read about results: the standings, made from the
// matches that count, and beside them every player's record from every
// match, so a new player's results show before their matches count.
// Making them reads every result, so they're kept until a result is added.

export type Board = {
  standings: Standings & { counts: string };
  records: RecordRow[];
};

let cached: { version: string; board: Board } | null = null;

// top cuts the standings. The records are a lookup by handle, so they're
// never cut: a player can always find their own.
export async function currentBoard(top: number): Promise<Board> {
  await sweep();
  const version = await resultsVersion();
  if (cached?.version !== version) {
    const results = await allResults();
    cached = {
      version,
      board: {
        standings: {
          ...rate(results, await playersSince()),
          counts: COUNTS,
        },
        records: computeRecords(GAME, results),
      },
    };
  }
  const { standings, records } = cached.board;
  return {
    standings: { ...standings, rows: standings.rows.slice(0, top) },
    records,
  };
}

export function forgetBoard(): void {
  cached = null;
}
