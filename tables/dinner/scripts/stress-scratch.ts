// Why the migration tests use a schema each, not a database each: times
// what each costs to throw away on a Postgres other people are writing to.
//
//   DINNER_TEST_DATABASE_URL=postgres://.../some_dinner_test npx tsx scripts/stress-scratch.ts
//
// DROP DATABASE makes Postgres take a checkpoint at once and wait for it,
// which writes out every dirty page in the whole cluster, everyone's. On a
// quiet machine that's quick; with other tenants writing, it can take longer
// than vitest's ten seconds for a hook. DROP SCHEMA takes no checkpoint.
// The script makes a database of its own to write to, makes and drops
// scratch databases and schemas with and without that writing going on, and
// prints the times and how many checkpoints were asked for. It drops
// everything it made.
import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyMigrations, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";

const base = process.env.DINNER_TEST_DATABASE_URL ?? "";
if (!base || !new URL(base).pathname.endsWith("_test"))
  throw new Error(
    "Set DINNER_TEST_DATABASE_URL to a database ending in _test.",
  );
const ROUNDS = Number(process.env.ROUNDS ?? 4);
const tag = randomBytes(3).toString("hex");

const withDb = (name: string, params: Record<string, string> = {}) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};
const admin = postgres(base, { max: 1, onnotice: () => {} });
const migrations = await loadMigrations(
  path.join(process.cwd(), "db/migrations"),
);

// Checkpoints asked for, and the ms they spent writing and syncing, so far,
// for the whole cluster.
async function checkpoints(): Promise<number[]> {
  const [r] = await admin<{ n: string; w: string; s: string }[]>`
    SELECT checkpoints_req::text AS n, checkpoint_write_time::text AS w,
      checkpoint_sync_time::text AS s FROM pg_stat_bgwriter`;
  return [Number(r?.n), Number(r?.w), Number(r?.s)];
}

async function time(f: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await f();
  return Math.round(performance.now() - t);
}

async function databases(): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const name = `stress_${tag}_db${i}_test`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await applyMigrations(withDb(name), migrations);
    out.push(
      await time(() => admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`)),
    );
  }
  return out;
}

async function schemas(): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const name = `stress_${tag}_s${i}`;
    await admin.unsafe(`CREATE SCHEMA ${name}`);
    await applyMigrations(
      withDb(new URL(base).pathname.slice(1), { search_path: name }),
      migrations,
    );
    out.push(await time(() => admin.unsafe(`DROP SCHEMA ${name} CASCADE`)));
  }
  return out;
}

// Another tenant: keeps dirtying pages until told to stop.
async function writer(stop: { now: boolean }): Promise<void> {
  const name = `stress_${tag}_load_test`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const sql = postgres(withDb(name), { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE t (id int PRIMARY KEY, v int, pad text)`;
    await sql`INSERT INTO t SELECT g, 0, repeat('x', 400)
      FROM generate_series(1, 150000) g`;
    while (!stop.now) await sql`UPDATE t SET v = v + 1 WHERE id % 3 = 0`;
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

async function report(label: string, f: () => Promise<number[]>) {
  const before = await checkpoints();
  const ms = await f();
  const [asked, wrote, synced] = (await checkpoints()).map((n, i) =>
    Math.round(n - (before[i] ?? 0)),
  );
  console.log(
    `${label.padEnd(24)} drop ms ${JSON.stringify(ms)} max ${Math.max(...ms)}; checkpoints asked ${asked}, writing ${wrote} ms, syncing ${synced} ms`,
  );
}

try {
  await report("database each, quiet", databases);
  await report("schema each, quiet", schemas);
  const stop = { now: false };
  const load = writer(stop);
  await new Promise((r) => setTimeout(r, 4000));
  await report("database each, writing", databases);
  await report("schema each, writing", schemas);
  stop.now = true;
  await load;
} finally {
  for (const r of await admin<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE ${`stress_${tag}_%`}`)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
  for (const r of await admin<{ nspname: string }[]>`
    SELECT nspname FROM pg_namespace WHERE nspname LIKE ${`stress_${tag}_%`}`)
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${r.nspname} CASCADE`);
  await admin.end();
}
