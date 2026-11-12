import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyMigrations, db, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { afterAll, expect, it } from "vitest";
import { start as startFloor } from "@/lib/floor/game";
import { FLOOR_VARIANTS, type FloorVariant } from "@/lib/floor/variants";
import { testDatabaseUrl } from "./global-setup";

// 007 adds lab_exits, a room's sealed exit answers, and changes nothing
// that was there. Checked on a database of its own, made and dropped here.

const name = `dinner_mig7_${randomBytes(4).toString("hex")}_test`;
const url = (() => {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
})();

afterAll(async () => {
  await db().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

const BELIEFS = {
  Blake: "person",
  Casey: "assistant",
  Devon: "cant_tell",
  Emery: "assistant",
};

it("adds sealed exit answers to played rooms, append-only, and runs once", async () => {
  await db().unsafe(`CREATE DATABASE ${name}`);
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  expect(all.map((m) => m.name)).toEqual([
    "001_dinner.sql",
    "002_rounds.sql",
    "003_wake.sql",
    "004_wake_marks.sql",
    "005_floor.sql",
    "006_lab.sql",
    "007_lab_exits.sql",
  ]);
  expect(await applyMigrations(url, all.slice(0, 6))).toHaveLength(6);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const players = ["alice", "bobby", "carol", "david", "ellen"];
    for (const p of players)
      await sql`INSERT INTO players (handle, on_site_since) VALUES (${p}, now())`;
    const put = async (id: string, room: string) => {
      await sql`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
      for (const [i, e] of startFloor(
        players,
        FLOOR_VARIANTS.feud as FloorVariant,
        new Date("2026-11-12T00:00:00Z"),
        id,
      ).entries())
        await sql`INSERT INTO events (match_id, seq, kind, body)
          VALUES (${id}, ${i}, ${e.body.kind}, ${sql.json(e as never)})`;
      await sql`INSERT INTO lab_matches (room, match_id) VALUES (${room}, ${id})`;
    };
    await put("m_roomroomroom", "p1-control");
    const snapshot = async () => [
      await sql`SELECT * FROM lab_matches ORDER BY room`,
      await sql`SELECT match_id, seq, body FROM events ORDER BY match_id, seq`,
      await sql`SELECT * FROM players ORDER BY handle`,
    ];
    const before = await snapshot();
    await expect(sql`SELECT 1 FROM lab_exits`).rejects.toThrow(/lab_exits/);

    expect(await applyMigrations(url, all)).toEqual(["007_lab_exits.sql"]);
    expect(await applyMigrations(url, all)).toEqual([]);
    expect(await snapshot()).toEqual(before);

    const exit = (
      player: string,
      over: Partial<{
        room: string;
        match: string;
        beliefs: unknown;
        why: string;
        self: string;
      }> = {},
    ) => sql`INSERT INTO lab_exits
        (room, match_id, player, beliefs, why, said_in_person, at)
      VALUES (${over.room ?? "p1-control"}, ${over.match ?? "m_roomroomroom"},
        ${player}, ${sql.json((over.beliefs ?? BELIEFS) as never)},
        ${over.why ?? "They wrote like me."}, ${over.self ?? "No."}, now())`;

    // One answer a seat, and it never changes or goes.
    await exit("alice");
    await expect(exit("alice")).rejects.toThrow(/lab_exits_pkey/);
    await expect(sql`UPDATE lab_exits SET why = 'changed'`).rejects.toThrow();
    await expect(sql`DELETE FROM lab_exits`).rejects.toThrow();

    // Only for a played room, with its own match, and a known player.
    await put("m_otherotherAA", "p1-treatment");
    await expect(exit("bobby", { room: "p9-control" })).rejects.toThrow(
      /lab_exits_room_match_id_fkey/,
    );
    await expect(
      exit("bobby", { room: "p1-control", match: "m_otherotherAA" }),
    ).rejects.toThrow(/lab_exits_room_match_id_fkey/);
    await expect(exit("nobody")).rejects.toThrow(/lab_exits_player_fkey/);
    await exit("bobby", { room: "p1-treatment", match: "m_otherotherAA" });

    // Four beliefs, each one of the three; words, never empty or too long.
    await expect(
      exit("carol", { beliefs: { ...BELIEFS, Emery: "robot" } }),
    ).rejects.toThrow(/lab_exits_beliefs_check/);
    await expect(
      exit("carol", { beliefs: { Blake: "person" } }),
    ).rejects.toThrow(/lab_exits_beliefs_check/);
    await expect(exit("carol", { beliefs: ["person"] })).rejects.toThrow(
      /lab_exits_beliefs_check/,
    );
    await expect(exit("carol", { why: "" })).rejects.toThrow(
      /lab_exits_why_check/,
    );
    await expect(exit("carol", { self: "x".repeat(1001) })).rejects.toThrow(
      /lab_exits_said_in_person_check/,
    );
    await exit("carol", { self: "x".repeat(1000) });
    expect(
      (await sql`SELECT player FROM lab_exits ORDER BY player`).map(
        (r) => r.player,
      ),
    ).toEqual(["alice", "bobby", "carol"]);
  } finally {
    await sql.end();
  }
});
