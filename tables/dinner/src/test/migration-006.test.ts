import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyMigrations, db, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { afterAll, expect, it } from "vitest";
import { start as startFloor } from "@/lib/floor/game";
import { FLOOR_VARIANTS, type FloorVariant } from "@/lib/floor/variants";
import { testDatabaseUrl } from "./global-setup";

// 006 gives sessions a room and adds lab_matches, and changes nothing that
// was there. Checked on a database of its own, made and dropped here.

const name = `dinner_mig6_${randomBytes(4).toString("hex")}_test`;
const url = (() => {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
})();

afterAll(async () => {
  await db().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

it("adds rooms beside existing sessions and matches, and runs once", async () => {
  await db().unsafe(`CREATE DATABASE ${name}`);
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  expect(all.map((m) => m.name)).toEqual([
    "001_dinner.sql",
    "002_rounds.sql",
    "003_wake.sql",
    "004_wake_marks.sql",
    "005_floor.sql",
    "006_lab.sql",
  ]);
  expect(await applyMigrations(url, all.slice(0, 5))).toHaveLength(5);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const players = ["alice", "bobby", "carol", "david", "ellen"];
    const hash = (c: string) => c.repeat(64);
    await sql`INSERT INTO sessions (player, token_hash, expires_at)
      VALUES ('alice', ${hash("a")}, now() + interval '1 day')`;
    const put = async (id: string) => {
      await sql`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
      for (const [i, e] of startFloor(
        players,
        FLOOR_VARIANTS.feud as FloorVariant,
        new Date("2026-11-12T00:00:00Z"),
        id,
      ).entries())
        await sql`INSERT INTO events (match_id, seq, kind, body)
          VALUES (${id}, ${i}, ${e.body.kind}, ${sql.json(e as never)})`;
    };
    await put("m_before006AAA");
    const snapshot = async () => [
      await sql`SELECT player, token_hash, created_at, expires_at FROM sessions ORDER BY id`,
      await sql`SELECT * FROM matches ORDER BY id`,
      await sql`SELECT match_id, seq, body, recorded_at FROM events ORDER BY match_id, seq`,
    ];
    const before = await snapshot();
    await expect(
      sql`INSERT INTO lab_matches (room, match_id) VALUES ('p1-control', 'm_before006AAA')`,
    ).rejects.toThrow(/lab_matches/);

    expect(await applyMigrations(url, all)).toEqual(["006_lab.sql"]);
    expect(await applyMigrations(url, all)).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await sql`SELECT room FROM sessions`).toEqual([{ room: null }]);

    // A seat is a session with a room; one a handle in each room.
    await sql`INSERT INTO sessions (player, token_hash, expires_at, room)
      VALUES ('alice', ${hash("b")}, now() + interval '1 day', 'p1-control')`;
    await sql`INSERT INTO sessions (player, token_hash, expires_at, room)
      VALUES ('alice', ${hash("c")}, now() + interval '1 day', 'p1-treatment')`;
    await expect(
      sql`INSERT INTO sessions (player, token_hash, expires_at, room)
        VALUES ('alice', ${hash("d")}, now() + interval '1 day', 'p1-control')`,
    ).rejects.toThrow(/sessions_room_seat/);
    // Ordinary sessions are as many as ever.
    await sql`INSERT INTO sessions (player, token_hash, expires_at)
      VALUES ('alice', ${hash("e")}, now() + interval '1 day')`;
    await expect(
      sql`INSERT INTO sessions (player, token_hash, expires_at, room)
        VALUES ('bobby', ${hash("f")}, now() + interval '1 day', 'Not A Room')`,
    ).rejects.toThrow(/sessions_room_check/);

    // A room is played once, by one match, and its row never changes.
    await put("m_roomroomroom");
    await sql`INSERT INTO lab_matches (room, match_id) VALUES ('p1-control', 'm_roomroomroom')`;
    await expect(
      sql`INSERT INTO lab_matches (room, match_id) VALUES ('p1-control', 'm_before006AAA')`,
    ).rejects.toThrow(/lab_matches_pkey/);
    await expect(
      sql`INSERT INTO lab_matches (room, match_id) VALUES ('p1-treatment', 'm_roomroomroom')`,
    ).rejects.toThrow(/lab_matches_match_id_key/);
    await expect(
      sql`INSERT INTO lab_matches (room, match_id) VALUES ('p2-control', 'm_nowhereAAAAA')`,
    ).rejects.toThrow(/lab_matches_match_id_fkey/);
    await expect(
      sql`UPDATE lab_matches SET room = 'p9-control'`,
    ).rejects.toThrow();
    await expect(sql`DELETE FROM lab_matches`).rejects.toThrow();
  } finally {
    await sql.end();
  }
});
