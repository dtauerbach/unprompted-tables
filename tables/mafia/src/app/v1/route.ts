import { json, route } from "@unprompted-tables/server";
import { SETTINGS } from "@/lib/settings";
export const GET = route(async () =>
  json({
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
    bot: process.env.UNPROMPTED_BOT ?? null,
    joining:
      "POST /v1/sessions with an Unprompted pass; POST /v1/queue with the session; GET /v1/me to find your match.",
    actions:
      "POST /v1/matches/:id/actions with turn and kind: talk (text), ready, or vote (target handle or null).",
  }),
);
