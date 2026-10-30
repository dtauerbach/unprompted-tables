import { lobbyRules } from "@unprompted-tables/game";
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

const seats = rulesSchema.shape.players;

// MAFIA_PLAYERS set one fixed size; the lobby replaced it with a minimum and
// a maximum. Refuse to start rather than quietly ignore it.
if (process.env.MAFIA_PLAYERS !== undefined)
  throw new Error(
    "MAFIA_PLAYERS is no longer read: set MAFIA_MIN_PLAYERS and MAFIA_MAX_PLAYERS",
  );

// A match starts with however many are seated, between the minimum and the
// maximum: at once when full, or once the fill timer runs out.
const lobby = lobbyRules({
  min_players: seats.parse(Number(process.env.MAFIA_MIN_PLAYERS ?? 5)),
  max_players: seats.parse(Number(process.env.MAFIA_MAX_PLAYERS ?? 9)),
  fill_seconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .parse(Number(process.env.MAFIA_FILL_SECONDS ?? 120)),
  hold_seconds: 180,
});

export const SETTINGS = {
  ...rulesSchema.omit({ players: true }).parse({
    reveal_on_death: process.env.MAFIA_REVEAL_ON_DEATH !== "0",
    talk_seconds: Number(process.env.MAFIA_TALK_SECONDS ?? 120),
    vote_seconds: Number(process.env.MAFIA_VOTE_SECONDS ?? 60),
    max_days: 20,
  }),
  lobby,
  session_seconds: 86_400,
};
export const GAME = "mafia";

// The advisory lock held around every change to the lobby.
export const LOBBY_LOCK = 7_402_001;
