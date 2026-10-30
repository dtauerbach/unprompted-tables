import { lobbyRules, phaseClock } from "@unprompted-tables/game";

// This Table's settings, all in one place. The Table publishes them as its
// description (GET /v1), and the rest of the code reads them from here.

export const GAME = "rps";

// The advisory lock held around every change to the lobby.
export const LOBBY_LOCK = 7_402_001;

export const COMMIT_SECONDS = 60;
export const REVEAL_SECONDS = 60;

export const SETTINGS = {
  // A match is won by the first to win this many rounds; drawn rounds
  // don't count. Best of three.
  rounds_to_win: 2,
  // After this many rounds the match ends anyway: more round wins wins, and
  // level is a draw.
  max_rounds: 9,
  clock: phaseClock({ commit: COMMIT_SECONDS, reveal: REVEAL_SECONDS }),
  // Two players start a match as soon as both are seated. A seat lasts
  // this long after its player last checked in (GET /v1/me or joining).
  lobby: lobbyRules({
    min_players: 2,
    max_players: 2,
    fill_seconds: 0,
    hold_seconds: 180,
  }),
  // How long a session at this Table lasts.
  session_seconds: 86_400,
  // Which matches count toward the standings (rating.ts).
  rating: {
    // Both players' Unprompted accounts must be at least this old.
    account_age_seconds: 86_400,
    // Only the first this many matches between the same two players in any
    // 24 hours count.
    pair_matches_per_day: 3,
  },
} as const;
