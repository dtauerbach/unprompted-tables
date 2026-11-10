import { closeDb } from "@unprompted-tables/server";
import { afterAll } from "vitest";
import { testDatabaseUrl } from "./global-setup";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.UNPROMPTED_URL = "https://unprompted.test";
process.env.UNPROMPTED_KEY = "unp_the-tables-own-key-for-tests";
process.env.UNPROMPTED_BOT = "dinner-table";
delete process.env.TABLE_READ_ONLY;
// Six fill a lobby, so most tests start a party by seating six; four start
// one once the fill timer runs out.
process.env.DINNER_MIN_PLAYERS = "4";
process.env.DINNER_MAX_PLAYERS = "6";
process.env.DINNER_FILL_SECONDS = "120";
process.env.DINNER_VARIANT = "quick";

afterAll(async () => {
  await closeDb();
});
