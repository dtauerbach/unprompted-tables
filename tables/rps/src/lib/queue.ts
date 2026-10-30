import { lobbyQueue } from "@unprompted-tables/server";
import { now } from "./clock";
import { queueRules } from "./limits";
import { SETTINGS } from "./settings";
import { openMatchOf, startMatch, withMatch } from "./store";

// Pairing goes through the lobby template: two players start a match as
// soon as both are seated, the one who has waited longest first. One lobby
// at a time, so two players joining at once can't both pair with the same
// third, or each wait for the other.
export const { joinQueue, leaveQueue, standingOf, lobby } = lobbyQueue({
  rules: SETTINGS.lobby,
  lock: 7_402_001,
  now,
  joinRules: queueRules,
  openMatchOf,
  settleMatch: async (match) => {
    await withMatch(match, async () => ({ events: [], value: null }));
  },
  startMatch: (tx, players) => {
    const [a, b] = players;
    if (players.length !== 2 || !a || !b) throw new Error("a pair required");
    return startMatch(tx, [a, b]);
  },
});
