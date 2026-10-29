import { z } from "zod";
import { GAME_RE, HANDLE_RE, MATCH_RE } from "./ids";

// Optional alternative to places. Side names and victory rules belong to
// the Table; this format neither ranks players nor feeds the Elo helper.
export const sideResultSchema = z
  .strictObject({
    game: z.string().regex(GAME_RE),
    match: z.string().regex(MATCH_RE),
    at: z.iso.datetime(),
    winner: z.string().min(1),
    players: z
      .array(
        z.strictObject({
          player: z.string().regex(HANDLE_RE),
          side: z.string().min(1),
        }),
      )
      .min(1),
  })
  .superRefine((r, ctx) => {
    if (new Set(r.players.map((p) => p.player)).size !== r.players.length)
      ctx.addIssue({ code: "custom", message: "lists a player twice" });
    if (!r.players.some((p) => p.side === r.winner))
      ctx.addIssue({ code: "custom", message: "winning side has no players" });
  });
export type SideResult = z.output<typeof sideResultSchema>;
