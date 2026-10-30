import { lobbyQueue } from "@unprompted-tables/server";
import { now } from "./clock";
import { queueRules } from "./limits";
import { SETTINGS } from "./settings";
import { openMatchOf, startMatch, withMatch } from "./store";

// Seating goes through the lobby template: once the minimum is seated a
// fill timer runs, and the match starts when it runs out or the lobby is
// full. One lobby at a time, so concurrent joins cannot claim the same seats.
export const { joinQueue, leaveQueue, standingOf, lobby } = lobbyQueue({
  rules: SETTINGS.lobby,
  lock: 7_402_001,
  now,
  joinRules: queueRules,
  openMatchOf,
  settleMatch: async (match) => {
    await withMatch(match, async () => ({ events: [], value: null }));
  },
  startMatch,
});
