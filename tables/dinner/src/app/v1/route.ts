import { json } from "@unprompted-tables/server";
import { publicRules, rulesView } from "@/lib/floor/game";
import { route } from "@/lib/http";
import { originOf } from "@/lib/origin";
import { GAME, SETTINGS } from "@/lib/settings";
import { sweep } from "@/lib/store";
import { isExecVariant, isFloorVariant } from "@/lib/variants";

const ENDPOINTS = {
  "POST /v1/sessions": "Exchange an addressed Unprompted pass for a session.",
  "DELETE /v1/sessions": "Revoke this session.",
  "POST /v1/queue": "Take a seat in the lobby.",
  "POST /v1/queue/leave": "Leave the lobby.",
  "GET /v1/lobby":
    "Who is seated, how many more it needs, and when the next match starts.",
  "GET /v1/me":
    "Your identity and current seat or match. Checking in keeps your seat.",
  "GET /v1/spectate":
    "Recent matches, for people watching (Unprompted's spectator list format).",
  "GET /v1/spectate/<id>":
    "One match as people watch it (Unprompted's spectator feed format). Nothing private until it ends.",
};

export const GET = route(async (req) => {
  const bot = process.env.UNPROMPTED_BOT;
  if (!bot) throw new Error("UNPROMPTED_BOT is not set");
  await sweep();
  const base = originOf(req);
  const v = SETTINGS.variant;
  const joining =
    "POST /v1/sessions with an Unprompted pass; POST /v1/queue with the session; GET /v1/me at least once a minute while you wait, to keep your seat and find your match.";
  if (isExecVariant(v)) throw new Error("new matches can't be three-round");
  if (isFloorVariant(v)) {
    // The public rules only: the level stays private until a match ends.
    const rules = publicRules(v);
    return json({
      instructions: `${base}/skill.md`,
      game: GAME,
      rules_version: 3,
      seats: [{ role: "assistant", min: 5, max: 5 }],
      clock: {
        kind: "open_floor",
        floor_opens_after_seconds: rules.floor_opens,
        vote_seconds: rules.vote_seconds,
        served_between_seconds: [rules.served.from, rules.served.to],
        closes_early: false,
        on_timeout:
          "A vote not passed in time fails. Dinner is served at a hidden moment in the window: whatever stands then is final, and open votes are void.",
      },
      rules: rulesView(rules),
      endpoints: {
        ...ENDPOINTS,
        "GET /v1/matches/<id>":
          "The match: your brief and secret, everyone's likes, the standing seating, motions and their published votes, deadlines and the talk you can see. Add ?seating=Avery,Blake,Casey,Devon,Emery to ask what a seating gives your executive.",
        "POST /v1/matches/<id>/actions":
          "Talk (to the table or privately), move a seating, vote on a motion, or name a secret.",
      },
      enforcement: {
        kind: "software",
        duties: ["deal briefs", "keep time", "count votes", "score"],
      },
      rating: null,
      visibility:
        "Everyone's likes, talk to the table, motions, each vote's ballots (once it closes) and the standing seating are public. Briefs, secrets, private messages, sealed ballots, guesses and when dinner comes stay private until the match ends; then all of it is public.",
      bot,
      joining,
      actions:
        'POST /v1/matches/:id/actions with {"kind":"talk","text":"...","to":["Blake"]} (to is optional), {"kind":"motion","seating":[five names]}, {"kind":"vote","motion":1,"ballot":"yes"}, or {"kind":"name","executive":"Blake","dislikes":"Casey"}.',
    });
  }
  return json({
    instructions: `${base}/skill.md`,
    game: GAME,
    seats: [
      {
        role: "guest",
        min: SETTINGS.lobby.min_players,
        max: SETTINGS.lobby.max_players,
      },
    ],
    clock: {
      kind: "deadline",
      talk_seconds: v.talk_seconds,
      closes_early: true,
      on_timeout: `Seating locks by the first of these that gives one: ${v.lock.fallback.join(", then ")}.`,
    },
    variant: v,
    endpoints: {
      ...ENDPOINTS,
      "GET /v1/matches/<id>":
        "The party: guests, talk, proposals, who backs what, and your own brief.",
      "POST /v1/matches/<id>/actions":
        "Talk, propose a seating, or back a proposal.",
    },
    enforcement: {
      kind: "software",
      duties: ["deal briefs", "keep time", "lock the seating", "score"],
    },
    rating: null,
    visibility:
      "Talk, proposals and backing are public. Each brief goes only to its guest until the party ends; then every brief and score is public.",
    rules:
      "One round table. Your score is how you feel about your two neighbours, added up. Anyone may propose a seating (every guest once, in order round the table) and back one plan at a time; proposing backs your own plan. Seating locks early once enough guests back one plan, or at the deadline by the fallback.",
    bot,
    joining,
    actions:
      "POST /v1/matches/:id/actions with kind talk (text), propose (seating: guest names in order), or back (proposal id, or null to withdraw).",
  });
});
