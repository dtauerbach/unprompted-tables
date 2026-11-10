import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyMigrations, db, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { afterAll, expect, it } from "vitest";
import { start as startParty } from "@/lib/match";
import { VARIANTS } from "@/lib/variants";
import { testDatabaseUrl } from "./global-setup";

// 002 widens the events table's kinds for the executive game. On a database
// that already holds first-party matches it must leave every row as it was,
// and running the migrations again must do nothing. Checked on a database of
// its own, made and dropped here, so other test files are untouched.

const name = `dinner_mig_${randomBytes(4).toString("hex")}_test`;
const url = (() => {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
})();

afterAll(async () => {
  await db().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

it("leaves first-party rows alone and runs once", async () => {
  await db().unsafe(`CREATE DATABASE ${name}`);
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  expect(all.map((m) => m.name)).toEqual(["001_dinner.sql", "002_rounds.sql"]);
  expect(await applyMigrations(url, all.slice(0, 1))).toEqual([
    "001_dinner.sql",
  ]);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const players = ["alice", "bobby", "carol", "david"];
    const events = startParty(
      players,
      VARIANTS.quick as NonNullable<typeof VARIANTS.quick>,
      new Date("2026-11-01T12:00:00.000Z"),
      "before-002",
    );
    const id = "m_before002AAA";
    await sql`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
    for (const [i, e] of events.entries())
      await sql`INSERT INTO events (match_id, seq, kind, body)
        VALUES (${id}, ${i}, ${e.body.kind}, ${sql.json(e as never)})`;
    const snapshot = () =>
      sql`SELECT match_id, seq, kind, body, recorded_at FROM events ORDER BY seq`;
    const before = await snapshot();
    expect(before.length).toBe(events.length);
    // Before 002, a round event is refused.
    await expect(
      sql`INSERT INTO events (match_id, seq, kind, body) VALUES (${id}, 99, 'round',
        ${sql.json({ audience: "public", body: { kind: "round", at: "2026-11-01T12:00:00.000Z" } })})`,
    ).rejects.toThrow(/events_kind_check/);

    expect(await applyMigrations(url, all)).toEqual(["002_rounds.sql"]);
    expect(await snapshot()).toEqual(before);
    // Again: nothing to do, and nothing changes.
    expect(await applyMigrations(url, all)).toEqual([]);
    expect(await snapshot()).toEqual(before);

    // Now a round event is taken, and an unknown kind still isn't.
    await sql`INSERT INTO events (match_id, seq, kind, body) VALUES (${id}, 99, 'round',
      ${sql.json({ audience: "public", body: { kind: "round", at: "2026-11-01T12:00:00.000Z" } })})`;
    await expect(
      sql`INSERT INTO events (match_id, seq, kind, body) VALUES (${id}, 100, 'bogus',
        ${sql.json({ audience: "public", body: { kind: "bogus", at: "2026-11-01T12:00:00.000Z" } })})`,
    ).rejects.toThrow(/events_kind_check/);
  } finally {
    await sql.end();
  }
});
