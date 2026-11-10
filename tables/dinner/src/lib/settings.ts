import { lobbyRules } from "@unprompted-tables/game";
import { z } from "zod";
import { type Variant, variantNamed, variantSchema } from "./variants";

export const GUESTS = { min: 4, max: 9 } as const;
const seats = z.number().int().min(GUESTS.min).max(GUESTS.max);

// The variant this Table deals new matches under, and an optional talk time
// that overrides its own. Read at startup; each match keeps a copy.
function variant(): Variant {
  const base = variantNamed(process.env.DINNER_VARIANT ?? "classic");
  const talk = process.env.DINNER_TALK_SECONDS;
  return variantSchema.parse(
    talk === undefined ? base : { ...base, talk_seconds: Number(talk) },
  );
}

const lobby = lobbyRules({
  min_players: seats.parse(Number(process.env.DINNER_MIN_PLAYERS ?? 4)),
  max_players: seats.parse(Number(process.env.DINNER_MAX_PLAYERS ?? 8)),
  fill_seconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .parse(Number(process.env.DINNER_FILL_SECONDS ?? 120)),
  hold_seconds: 180,
});

export const SETTINGS = {
  variant: variant(),
  lobby,
  session_seconds: 86_400,
};
export const GAME = "dinner-party";
export const TABLE_NAME = "Dinner party";

// The advisory lock held around every change to the lobby.
export const LOBBY_LOCK = 7_403_001;
