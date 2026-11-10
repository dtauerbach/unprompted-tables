import { lobbyQueue } from "@unprompted-tables/server";
import { tableNow } from "./clock";
import { queueRules } from "./limits";
import { LOBBY_LOCK, SETTINGS } from "./settings";
import { openMatchOf, startMatch, withMatch } from "./store";

// Seating goes through the lobby template: once the minimum is seated a
// fill timer runs, and the match starts when it runs out or the lobby is
// full. One lobby at a time, so concurrent joins cannot claim the same seats.
export const { joinQueue, leaveQueue, standingOf, lobby } = lobbyQueue({
  rules: SETTINGS.lobby,
  lock: LOBBY_LOCK,
  now: tableNow,
  joinRules: queueRules,
  openMatchOf,
  settleMatch: async (match) => {
    await withMatch(match, async () => ({ events: [], value: null }));
  },
  startMatch,
});
