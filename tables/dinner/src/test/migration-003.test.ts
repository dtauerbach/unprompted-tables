import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyMigrations, db, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { afterAll, expect, it } from "vitest";
import { start as startExec } from "@/lib/exec/game";
import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { testDatabaseUrl } from "./global-setup";

// 003 adds the tables for waking players and touches nothing else. Checked
// on a database of its own, made and dropped here.

const name = `dinner_mig3_${randomBytes(4).toString("hex")}_test`;
const url = (() => {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
})();

afterAll(async () => {
  await db().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

it("adds leave and reads beside existing matches, and runs once", async () => {
  await db().unsafe(`CREATE DATABASE ${name}`);
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  expect(all.map((m) => m.name)).toEqual([
    "001_dinner.sql",
    "002_rounds.sql",
    "003_wake.sql",
  ]);
  expect(await applyMigrations(url, all.slice(0, 2))).toEqual([
    "001_dinner.sql",
    "002_rounds.sql",
  ]);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const players = ["alice", "bobby", "carol", "david", "ellen"];
    const events = startExec(
      players,
      EXEC_VARIANTS.standoff as NonNullable<typeof EXEC_VARIANTS.standoff>,
      new Date("2026-11-10T12:00:00.000Z"),
      "before-003",
    );
    const id = "m_before003AAA";
    await sql`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
    for (const [i, e] of events.entries())
      await sql`INSERT INTO events (match_id, seq, kind, body)
        VALUES (${id}, ${i}, ${e.body.kind}, ${sql.json(e as never)})`;
    const snapshot = () =>
      sql`SELECT match_id, seq, kind, body, recorded_at FROM events ORDER BY seq`;
    const before = await snapshot();

    expect(await applyMigrations(url, all)).toEqual(["003_wake.sql"]);
    expect(await snapshot()).toEqual(before);
    expect(await applyMigrations(url, all)).toEqual([]);

    await sql`INSERT INTO wake_leave (player, until) VALUES ('alice', now() + interval '1 day')`;
    await sql`INSERT INTO match_reads (match_id, player, waiting, nudges)
      VALUES (${id}, 'alice', true, 1)`;
    // Only handles, only real matches, never a negative count.
    await expect(
      sql`INSERT INTO wake_leave (player, until) VALUES ('Not A Handle', now())`,
    ).rejects.toThrow(/wake_leave_player_check/);
    await expect(
      sql`INSERT INTO match_reads (match_id, player) VALUES ('m_nosuchmatch', 'bobby')`,
    ).rejects.toThrow(/foreign key/);
    await expect(
      sql`INSERT INTO match_reads (match_id, player, nudges) VALUES (${id}, 'bobby', -1)`,
    ).rejects.toThrow(/match_reads_nudges_check/);
  } finally {
    await sql.end();
  }
});
