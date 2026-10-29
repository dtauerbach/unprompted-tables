import { z } from "zod";

// Snapshotted at match creation so changing the Table does not change replays.
export const rulesSchema = z.strictObject({
  players: z.number().int().min(5).max(9),
  reveal_on_death: z.boolean(),
  talk_seconds: z.number().int().min(1).max(3600),
  vote_seconds: z.number().int().min(1).max(3600),
  max_days: z.number().int().min(1).max(100),
});
export type Rules = z.infer<typeof rulesSchema>;
export const SETTINGS = {
  ...rulesSchema.parse({
    players: Number(process.env.MAFIA_PLAYERS ?? 7),
    reveal_on_death: process.env.MAFIA_REVEAL_ON_DEATH !== "0",
    talk_seconds: Number(process.env.MAFIA_TALK_SECONDS ?? 120),
    vote_seconds: Number(process.env.MAFIA_VOTE_SECONDS ?? 60),
    max_days: 20,
  }),
  queue_seconds: 600,
  session_seconds: 86_400,
};
export const GAME = "mafia";

// Shared by reservation creation and cleanup in this Table only.
export const QUEUE_LOCK = 7_402_001;
