import { ELO_K, ELO_START, eloChanges } from "./elo";
import { type Result, resultSchema } from "./result";

// Elo standings for one game from every result its Table has recorded, for
// a Table that chooses Elo. The same results give the same standings in any
// order, because they are replayed sorted by time and then match.

export const ELO_METHOD = `Elo, K=${ELO_K}, from ${ELO_START}`;

// A player's plain record: how many matches they played, won, lost and
// drew, with no rating.
export type RecordRow = {
  player: string;
  played: number;
  won: number;
  lost: number;
  drawn: number;
};

export type StandingsRow = RecordRow & { rating: number };

export type Standings = { method: string; rows: StandingsRow[] };

// Won means alone in first place, drawn means sharing it, lost means
// anywhere below it.
function outcome(result: Result, player: string): "won" | "drawn" | "lost" {
  const mine = result.players.find((p) => p.player === player)?.place;
  if (mine !== 1) return "lost";
  return result.players.filter((p) => p.place === 1).length > 1
    ? "drawn"
    : "won";
}

export function sortResults(results: readonly Result[]): Result[] {
  return [...results].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.match < b.match ? -1 : 1,
  );
}

function checked(game: string, results: readonly unknown[]): Result[] {
  const parsed = results.map((r) => resultSchema.parse(r));
  const seen = new Set<string>();
  for (const r of parsed) {
    if (r.game !== game)
      throw new Error(`match ${r.match} is from ${r.game}, not ${game}`);
    if (seen.has(r.match)) throw new Error(`match ${r.match} appears twice`);
    seen.add(r.match);
  }
  return parsed;
}

function tally(results: readonly Result[]): RecordRow[] {
  const rows = new Map<string, RecordRow>();
  for (const result of results)
    for (const { player } of result.players) {
      const row = rows.get(player) ?? {
        player,
        played: 0,
        won: 0,
        lost: 0,
        drawn: 0,
      };
      row.played += 1;
      row[outcome(result, player)] += 1;
      rows.set(player, row);
    }
  return [...rows.values()];
}

export function computeStandings(
  game: string,
  results: readonly unknown[],
  opts: { top?: number } = {},
): Standings {
  if (opts.top !== undefined && !(Number.isInteger(opts.top) && opts.top >= 0))
    throw new Error("top must be a whole number, 0 or more");
  const parsed = sortResults(checked(game, results));
  const ratings = new Map<string, number>();
  for (const result of parsed)
    for (const [player, delta] of eloChanges(result, ratings))
      ratings.set(player, (ratings.get(player) ?? ELO_START) + delta);

  const ranked = tally(parsed)
    .map((row) => ({
      ...row,
      rating: Math.round(ratings.get(row.player) ?? ELO_START),
    }))
    .sort(
      (a, b) =>
        b.rating - a.rating || b.won - a.won || (a.player < b.player ? -1 : 1),
    )
    .slice(0, opts.top ?? Number.POSITIVE_INFINITY)
    .map(({ player, rating, played, won, lost, drawn }) => ({
      player,
      rating,
      played,
      won,
      lost,
      drawn,
    }));
  return { method: ELO_METHOD, rows: ranked };
}

// Every player's record from every result given, with no rating, in order
// of handle. A Table that rates only some matches can show this beside its
// standings, so a player's results show from their first match. It is a
// lookup, not a ranking: ordering it by wins would reward exactly the
// farming a Table's rating rules leave out.
export function computeRecords(
  game: string,
  results: readonly unknown[],
): RecordRow[] {
  return tally(checked(game, results))
    .sort((a, b) => (a.player < b.player ? -1 : 1))
    .map(({ player, played, won, lost, drawn }) => ({
      player,
      played,
      won,
      lost,
      drawn,
    }));
}
