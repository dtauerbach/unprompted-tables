import path from "node:path";
import { applyMigrations, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";

// Tests wipe the database, so they only ever run against one whose name ends
// in _test, given as DINNER_TEST_DATABASE_URL. They never read DATABASE_URL.
export function testDatabaseUrl(): string {
  const url = process.env.DINNER_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "Set DINNER_TEST_DATABASE_URL to a throwaway Postgres database whose name ends in _test, e.g. postgres://postgres:postgres@localhost:5432/dinner_test",
    );
  if (
    url === process.env.TEST_DATABASE_URL ||
    url === process.env.MAFIA_TEST_DATABASE_URL
  )
    throw new Error("Dinner tests need a database of their own.");
  if (!new URL(url).pathname.endsWith("_test"))
    throw new Error(
      "DINNER_TEST_DATABASE_URL must name a database ending in _test.",
    );
  return url;
}

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`DROP SCHEMA public CASCADE`;
  await sql`CREATE SCHEMA public`;
  // Scratch schemas the migration tests left behind if a run was cut short
  // (src/test/scratch-schema.ts names them). The pattern goes as a
  // parameter, so its escaped underscores reach Postgres as written, and
  // each name is quoted.
  for (const { drop } of await sql<{ drop: string }[]>`
    SELECT format('DROP SCHEMA %I CASCADE', nspname) AS drop
    FROM pg_namespace WHERE nspname LIKE ${"dinner\\_mig\\_%"}`)
    await sql.unsafe(drop);
  await sql.end();
  await applyMigrations(
    url,
    await loadMigrations(path.join(process.cwd(), "db/migrations")),
  );
}
