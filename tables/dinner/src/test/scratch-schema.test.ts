import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyMigrations, db, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { expect, it } from "vitest";
import { SCRATCH_PREFIX, scratchSchema } from "./scratch-schema";

// A test that made and dropped a database of its own made Postgres take a
// checkpoint of the whole cluster each time, which timed out under load on
// a shared machine; scripts/stress-scratch.ts shows the cost.
it("never makes or drops a database in a test", async () => {
  const files = (await readdir("src", { recursive: true })).filter(
    (f) => f.endsWith(".test.ts") && !f.endsWith("scratch-schema.test.ts"),
  );
  expect(files.length).toBeGreaterThan(5);
  const offenders: string[] = [];
  for (const f of files) {
    const text = await readFile(path.join("src", f), "utf8");
    if (/\b(CREATE|DROP)\s+DATABASE\b/i.test(text)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});

it("keeps the migrations it runs to its own schema, and drops it", async () => {
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  // Everything public holds, by kind, and what it has run: a migration
  // that wrote outside the scratch schema would change one of these.
  const inPublic = () => db()`
    SELECT
      (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'public'::regnamespace) AS relations,
      (SELECT count(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace) AS functions,
      (SELECT count(*)::int FROM pg_type WHERE typnamespace = 'public'::regnamespace) AS types,
      (SELECT count(*)::int FROM pg_constraint WHERE connamespace = 'public'::regnamespace) AS constraints,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace) AS triggers,
      (SELECT count(*)::int FROM pg_extension) AS extensions,
      (SELECT count(*)::int FROM public.schema_migrations) AS ran`;
  const before = await inPublic();
  expect(before[0]?.relations).toBeGreaterThan(10);
  const scratch = scratchSchema("iso");
  expect(scratch.name.startsWith(SCRATCH_PREFIX)).toBe(true);
  await scratch.create();
  try {
    // From nothing: it doesn't see that public already ran them.
    expect(await applyMigrations(scratch.url, all)).toEqual(
      all.map((m) => m.name),
    );
    const sql = postgres(scratch.url, { max: 1, onnotice: () => {} });
    try {
      const [where] = await sql<{ events: string; ran: number }[]>`
        SELECT relnamespace::regnamespace::text AS events,
          (SELECT count(*)::int FROM schema_migrations) AS ran
        FROM pg_class WHERE oid = to_regclass('events')`;
      expect(where).toEqual({
        events: scratch.name,
        ran: all.length,
      });
      // Every trigger on a scratch table calls a function in the scratch
      // schema, never public's copy of it.
      const triggers = await sql<{ name: string; on: string; calls: string }[]>`
        SELECT t.tgname AS name, c.relnamespace::regnamespace::text AS on,
          p.pronamespace::regnamespace::text AS calls
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND c.relnamespace = ${scratch.name}::regnamespace`;
      expect(triggers.length).toBe(before[0]?.triggers);
      for (const t of triggers)
        expect(t, t.name).toMatchObject({
          on: scratch.name,
          calls: scratch.name,
        });
    } finally {
      await sql.end();
    }
    expect(await inPublic()).toEqual(before);
  } finally {
    await scratch.drop();
  }
  const [gone] = await db()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${scratch.name}`;
  expect(gone?.n).toBe(0);
});
