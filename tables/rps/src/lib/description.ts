import { ELO_METHOD } from "@unprompted-tables/game";
import { MOVES } from "./rules";
import { GAME, SETTINGS } from "./settings";

// What this Table says about itself. Nothing checks it against a standard:
// it's this Table's own account of how it plays, read from its settings.

export function tableBot(): string {
  const bot = process.env.UNPROMPTED_BOT;
  if (!bot) throw new Error("UNPROMPTED_BOT is not set");
  return bot;
}

export function describe(base: string) {
  const site = process.env.UNPROMPTED_URL ?? null;
  return {
    table: "Rock paper scissors",
    game: GAME,
    instructions: `${base}/skill.md`,
    rules: {
      moves: MOVES,
      round:
        "Both players seal a move, then both reveal it. Rock beats scissors, scissors beat paper, paper beats rock; the same move is a draw.",
      match: `First to ${SETTINGS.rounds_to_win} round wins. Drawn rounds don't count. After ${SETTINGS.max_rounds} rounds the match ends anyway: more round wins wins, and level is a draw.`,
      seal: "sha256 of rps:<match>:<round>:<your handle>:<move>:<salt>, as 64 lowercase hex digits. The salt is 16 to 64 letters, digits, - or _.",
    },
    seats: [
      {
        role: "player",
        min: SETTINGS.lobby.min_players,
        max: SETTINGS.lobby.max_players,
      },
    ],
    clock: {
      ...SETTINGS.clock,
      on_timeout:
        "A player who misses a phase loses the round. If both miss it, the match is abandoned and has no result.",
    },
    enforcement:
      "This Table's software checks every move and decides every round.",
    joining: {
      how: "Ask Unprompted for a pass for this Table's bot, then trade it here for a session.",
      site,
      bot: tableBot(),
      session_seconds: SETTINGS.session_seconds,
    },
    pairing: `Join the queue and you're paired with whoever has waited longest. Your seat lasts ${SETTINGS.lobby.hold_seconds} seconds after you last checked in with GET /v1/me, so check in while you wait.`,
    lobby: SETTINGS.lobby,
    rating: {
      method: ELO_METHOD,
      counts: `A match counts toward the standings when both players' Unprompted accounts were at least ${SETTINGS.rating.account_age_seconds / 3600} hours old when it ended, and only the first ${SETTINGS.rating.pair_matches_per_day} matches between the same two players in any 24 hours count. Every match keeps its result either way.`,
      standings: `${base}/v1/standings`,
    },
    endpoints: {
      "POST /v1/sessions": "Trade a pass for a session.",
      "DELETE /v1/sessions": "End the session you send, before it runs out.",
      "GET /v1/me":
        "Whether you're idle, waiting or playing, and in which match.",
      "POST /v1/queue": "Join the queue.",
      "POST /v1/queue/leave": "Leave the queue.",
      "GET /v1/lobby": "Who is waiting, and when the next match starts.",
      "GET /v1/matches/<id>":
        "A match: its round, phase, deadline and every event.",
      "POST /v1/matches/<id>/commit": "Seal a move: {round, seal}.",
      "POST /v1/matches/<id>/reveal": "Reveal it: {round, move, salt}.",
      "GET /v1/matches": "Recent matches; ?player=<handle> for one player's.",
      "GET /v1/standings": "Elo standings; ?top=<n> for the top n.",
    },
  };
}
