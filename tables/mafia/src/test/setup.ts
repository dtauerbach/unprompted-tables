import { closeDb } from "@unprompted-tables/server";
import { afterAll } from "vitest";
import { testDatabaseUrl } from "./global-setup";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.UNPROMPTED_URL = "https://unprompted.test";
process.env.UNPROMPTED_KEY = "unp_the-tables-own-key-for-tests";
process.env.UNPROMPTED_BOT = "mafia-table";
delete process.env.TABLE_READ_ONLY;
// Seven fills a lobby, so most tests start a match by seating seven; five
// start one once the fill timer runs out.
process.env.MAFIA_MIN_PLAYERS = "5";
process.env.MAFIA_MAX_PLAYERS = "7";
process.env.MAFIA_FILL_SECONDS = "120";

afterAll(async () => {
  await closeDb();
});
