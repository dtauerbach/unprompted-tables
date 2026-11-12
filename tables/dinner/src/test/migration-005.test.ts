import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyMigrations, db, loadMigrations } from "@unprompted-tables/server";
import postgres from "postgres";
import { afterAll, expect, it } from "vitest";
import { start as startExec } from "@/lib/exec/game";
import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { start as startFloor } from "@/lib/floor/game";
import { FLOOR_VARIANTS } from "@/lib/floor/variants";
import { testDatabaseUrl } from "./global-setup";

// 005 lets events hold the open floor's two new kinds, a vote's close and a
// sealed guess, and touches nothing else. Checked on a database of its own,
// made and dropped here.

const name = `dinner_mig5_${randomBytes(4).toString("hex")}_test`;
const url = (() => {
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${name}`;
  return u.toString();
})();

afterAll(async () => {
  await db().unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
});

it("takes motions and guesses beside existing matches, and runs once", async () => {
  await db().unsafe(`CREATE DATABASE ${name}`);
  const all = await loadMigrations(path.join(process.cwd(), "db/migrations"));
  expect(all[4]?.name).toBe("005_floor.sql");
  expect(await applyMigrations(url, all.slice(0, 4))).toHaveLength(4);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const players = ["alice", "bobby", "carol", "david", "ellen"];
    const put = async (
      id: string,
      kinds: { kind: string; body: unknown }[],
    ) => {
      await sql`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
      for (const [i, e] of kinds.entries())
        await sql`INSERT INTO events (match_id, seq, kind, body)
          VALUES (${id}, ${i}, ${e.kind}, ${sql.json(e.body as never)})`;
    };
    const at = new Date("2026-11-10T12:00:00.000Z");
    const old = startExec(
      players,
      EXEC_VARIANTS.standoff as NonNullable<typeof EXEC_VARIANTS.standoff>,
      at,
      "before-005",
    );
    await put(
      "m_before005AAA",
      old.map((e) => ({ kind: e.body.kind, body: e })),
    );
    // Shaped as the store keeps them, so only the kind is in question.
    const ev = (kind: string, audience: unknown = "public") => ({
      kind,
      body: { audience, body: { kind, at: at.toISOString() } },
    });
    const motion = ev("motion");
    const guess = ev("name", ["alice"]);
    // Before 005, neither kind is allowed.
    await expect(put("m_early005AAAA", [motion])).rejects.toThrow(
      /events_kind_check/,
    );
    const snapshot = () =>
      sql`SELECT match_id, seq, kind, body, recorded_at FROM events ORDER BY match_id, seq`;
    const before = await snapshot();

    expect(await applyMigrations(url, all.slice(0, 5))).toEqual([
      "005_floor.sql",
    ]);
    expect(await applyMigrations(url, all.slice(0, 5))).toEqual([]);
    expect(await snapshot()).toEqual(before);

    const floor = startFloor(
      players,
      FLOOR_VARIANTS.feud as NonNullable<typeof FLOOR_VARIANTS.feud>,
      at,
      "after-005",
    );
    await put("m_after005AAAA", [
      ...floor.map((e) => ({ kind: e.body.kind, body: e })),
      motion,
      guess,
    ]);
    await expect(put("m_unknownAAAAA", [ev("verdict")])).rejects.toThrow(
      /events_kind_check/,
    );
  } finally {
    await sql.end();
  }
});
