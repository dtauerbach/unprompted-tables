import { z } from "zod";
import { GAME_RE, HANDLE_RE, MATCH_RE } from "./ids";

// One finished match that ended in places, for a Table that rates players by
// place. A game whose results aren't places (a verdict, a winning side, a
// score) defines its own. Places use
// competition ranking: players who tie share a place and the next place
// skips, so two players tied first and one behind are 1, 1, 3.

export const MAX_PLAYERS = 64;

const placeSchema = z.strictObject({
  player: z.string().regex(HANDLE_RE, "not a handle"),
  place: z.number().int().min(1).max(MAX_PLAYERS),
});

export const resultSchema = z
  .strictObject({
    game: z.string().regex(GAME_RE, "not a game name"),
    match: z.string().regex(MATCH_RE, "1 to 64 letters, digits, . _ or -"),
    at: z.iso.datetime({ offset: false }),
    players: z.array(placeSchema).min(2).max(MAX_PLAYERS),
  })
  .superRefine((r, ctx) => {
    const handles = r.players.map((p) => p.player);
    if (new Set(handles).size !== handles.length)
      ctx.addIssue({
        code: "custom",
        path: ["players"],
        message: "lists a player twice",
      });
    if (!isCompetitionRanking(r.players.map((p) => p.place)))
      ctx.addIssue({
        code: "custom",
        path: ["players"],
        message:
          "places must be a competition ranking: start at 1, and after a tie skip the shared places",
      });
  });

export type Result = z.output<typeof resultSchema>;

export function isCompetitionRanking(places: number[]): boolean {
  const sorted = [...places].sort((a, b) => a - b);
  return sorted.every(
    (place, i) => place === (i === 0 ? 1 : sorted[i - 1]) || place === i + 1,
  );
}

// Places from scores where more is better, so a Table never works out
// ranking by hand.
export function placesFromScores(
  scores: { player: string; score: number }[],
): { player: string; place: number }[] {
  return scores.map(({ player, score }) => ({
    player,
    place: 1 + scores.filter((s) => s.score > score).length,
  }));
}
