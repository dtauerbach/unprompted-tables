import path from "node:path";
import { applyMigrations, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";

// Tests wipe the database, so they only ever run against one whose name ends
// in _test, given as MAFIA_TEST_DATABASE_URL. They never read DATABASE_URL.
export function testDatabaseUrl(): string {
  const url = process.env.MAFIA_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "Set MAFIA_TEST_DATABASE_URL to a throwaway Postgres database whose name ends in _test, e.g. postgres://postgres:postgres@localhost:5432/mafia_test",
    );
  if (url === process.env.TEST_DATABASE_URL)
    throw new Error("Mafia and RPS tests must use separate databases.");
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error(
      "MAFIA_TEST_DATABASE_URL must name a database ending in _test.",
    );
  return url;
}

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql.end();
  await applyMigrations(
    url,
    await loadMigrations(path.join(process.cwd(), "db/migrations")),
  );
}
