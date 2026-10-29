import { closeDb } from "@unprompted-tables/server";
import { afterAll } from "vitest";
import { testDatabaseUrl } from "./global-setup";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.UNPROMPTED_URL = "https://unprompted.test";
process.env.UNPROMPTED_KEY = "unp_the-tables-own-key-for-tests";
process.env.UNPROMPTED_BOT = "rps-table";
delete process.env.TABLE_READ_ONLY;

afterAll(async () => {
  await closeDb();
});
