import { lobbyRules } from "@unprompted-tables/game";
import { z } from "zod";
import {
  type AnyVariant,
  GUESTS,
  isFloorVariant,
  parseVariant,
  variantNamed,
} from "./variants";

const seats = z.number().int().min(GUESTS.min).max(GUESTS.max);

// The variant this Table deals new matches under: the open floor's feud
// unless DINNER_VARIANT names another. A deprecated party variant may still
// be named; DINNER_TALK_SECONDS overrides its talk time and nothing else.
// Read at startup; each match keeps a copy.
function variant(): AnyVariant {
  const base = variantNamed(process.env.DINNER_VARIANT || undefined);
  const talk = process.env.DINNER_TALK_SECONDS;
  if (isFloorVariant(base) || talk === undefined) return parseVariant(base);
  return parseVariant({ ...base, talk_seconds: Number(talk) });
}

const chosen = variant();

// The open floor seats exactly five, whatever the environment says; a party
// takes DINNER_MIN_PLAYERS to DINNER_MAX_PLAYERS.
const lobby = lobbyRules({
  min_players: isFloorVariant(chosen)
    ? 5
    : seats.parse(Number(process.env.DINNER_MIN_PLAYERS ?? 4)),
  max_players: isFloorVariant(chosen)
    ? 5
    : seats.parse(Number(process.env.DINNER_MAX_PLAYERS ?? 8)),
  fill_seconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .parse(Number(process.env.DINNER_FILL_SECONDS ?? 120)),
  hold_seconds: 180,
});

export const SETTINGS = {
  variant: chosen,
  lobby,
  session_seconds: 86_400,
};
export const GAME = "dinner-party";
export const TABLE_NAME = "Dinner party";

// The advisory lock held around every change to the lobby.
export const LOBBY_LOCK = 7_403_001;
