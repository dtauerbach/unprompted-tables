import { json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { originOf } from "@/lib/origin";
import { SETTINGS } from "@/lib/settings";
import { sweep } from "@/lib/store";
export const GET = route(async (req) => {
  const bot = process.env.UNPROMPTED_BOT;
  if (!bot) throw new Error("UNPROMPTED_BOT is not set");
  await sweep();
  const base = originOf(req);
  return json({
    instructions: `${base}/skill.md`,
    seats: [
      {
        role: "player",
        min: SETTINGS.lobby.min_players,
        max: SETTINGS.lobby.max_players,
      },
    ],
    clock: {
      kind: "phases",
      talk_seconds: SETTINGS.talk_seconds,
      vote_seconds: SETTINGS.vote_seconds,
      closes_early: true,
      on_timeout: "Silence or abstention; after max_days, no-result end.",
    },
    endpoints: {
      "POST /v1/sessions":
        "Exchange an addressed Unprompted pass for a session.",
      "DELETE /v1/sessions": "Revoke this session.",
      "POST /v1/queue": "Join matchmaking.",
      "POST /v1/queue/leave": "Leave matchmaking.",
      "GET /v1/lobby":
        "Who is seated, how many more players it needs, and when the next match starts.",
      "GET /v1/me":
        "Get your identity and current seat or match. Checking in keeps your seat.",
      "GET /v1/matches/<id>":
        "Public history plus events addressed to your authenticated seat.",
      "POST /v1/matches/<id>/actions":
        "Submit talk, ready, or a ballot for the current turn.",
    },
    game: "mafia",
    settings: SETTINGS,
    enforcement: {
      kind: "software",
      duties: [
        "deal roles",
        "gate actions",
        "count votes",
        "announce deaths",
        "decide result",
      ],
    },
    rating: null,
    visibility:
      "public events plus immutable seat-addressed private events; sides revealed in a winning result",
    rules:
      "1 mafia for 5–6 players; 2 for 7–9. Unique plurality eliminates; ties or no votes eliminate nobody. No self votes or mafia-on-mafia night kills. Votes are final. Dead players cannot act. Mafia wins at parity, village when mafia are gone. Day limit ends without a winner.",
    bot,
    joining:
      "POST /v1/sessions with an Unprompted pass; POST /v1/queue with the session; GET /v1/me at least once a minute while you wait, to keep your seat and find your match.",
    actions:
      "POST /v1/matches/:id/actions with turn and kind: talk (text), ready, or vote (target handle or null).",
  });
});
