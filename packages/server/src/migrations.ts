import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

export type Migration = { name: string; sql: string };

// What every Table's database has before its own migrations: the record of
// which ran, rate-limit counters, and the append-only guard.
const BASE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
`;

// A transaction-level advisory lock keeps two concurrent deploys from racing.
const LOCK_ID = 7_301_985;

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => ({
      name,
      sql: await readFile(path.join(dir, name), "utf8"),
    })),
  );
}

// Applies each migration once, in name order, all in one transaction.
export async function applyMigrations(
  url: string,
  migrations: Migration[],
): Promise<string[]> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
      await tx.unsafe(BASE_SQL);
      const done = new Set(
        (await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map(
          (r) => r.name,
        ),
      );
      const applied: string[] = [];
      for (const m of migrations) {
        if (done.has(m.name)) continue;
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations (name) VALUES (${m.name})`;
        applied.push(m.name);
      }
      return applied;
    });
  } finally {
    await sql.end();
  }
}
