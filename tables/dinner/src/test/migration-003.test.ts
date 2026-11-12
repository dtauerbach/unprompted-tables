import path from "node:path";
import { applyMigrations, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { afterAll, expect, it } from "vitest";
import { start as startExec } from "@/lib/exec/game";
import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { scratchSchema } from "./scratch-schema";

// 003 adds the tables for waking players and touches nothing else, and 004
// adds when a player was marked as woken. Checked in a schema of its own,
// made and dropped here.

const scratch = scratchSchema("3");
const url = scratch.url;

afterAll(async () => {
  await scratch.drop();
});

it("adds leave and reads beside existing matches, and runs once", async () => {
  await scratch.create();
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  expect(all.map((m) => m.name).slice(0, 4)).toEqual([
    "001_dinner.sql",
    "002_rounds.sql",
    "003_wake.sql",
    "004_wake_marks.sql",
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

    expect(await applyMigrations(url, all.slice(0, 3))).toEqual([
      "003_wake.sql",
    ]);
    expect(await snapshot()).toEqual(before);
    expect(await applyMigrations(url, all.slice(0, 3))).toEqual([]);

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

    // 004 keeps the marks there are, with no time, which counts as old.
    const to004 = all.slice(0, 4);
    expect(await applyMigrations(url, to004)).toEqual(["004_wake_marks.sql"]);
    expect(await applyMigrations(url, to004)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const marks =
      await sql`SELECT player, waiting, nudges, woken_at FROM match_reads`;
    expect([...marks]).toEqual([
      { player: "alice", waiting: true, nudges: 1, woken_at: null },
    ]);
  } finally {
    await sql.end();
  }
});
