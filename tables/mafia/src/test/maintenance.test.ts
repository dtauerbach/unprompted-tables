import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { GET as describe } from "@/app/v1/route";
import { moveClock, now } from "@/lib/clock";
import { act, start } from "@/lib/match";
import { startMatch, sweep, withMatch } from "@/lib/store";
import { call, resetDb, sessionFor } from "./helpers";

const players = ["alice", "bobby", "carol", "david", "ellen", "frank", "grace"];
beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
  vi.restoreAllMocks();
});
async function submit(
  id: string,
  player: string,
  action: Parameters<typeof act>[2],
) {
  return withMatch(id, async (s, _events, _tx, at) => ({
    events: act(s, player, action, at),
    value: null,
  }));
}
it("publishes discoverable settings and fails when its bot is unconfigured", async () => {
  const res = await call(describe);
  expect(res.status).toBe(200);
  for (const key of ["clock", "seats", "instructions", "endpoints", "bot"])
    expect(res.body).toHaveProperty(key);
  const bot = process.env.UNPROMPTED_BOT;
  delete process.env.UNPROMPTED_BOT;
  vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await call(describe)).status).toBe(500);
  } finally {
    process.env.UNPROMPTED_BOT = bot;
  }
});
it("sweeps abandoned matches and expired reservations/sessions, but not in read-only mode", async () => {
  await sessionFor("expired");
  await db()`INSERT INTO queue(player,expires_at) VALUES('expired',${now()})`;
  const id = await db().begin((tx) => startMatch(tx, players));
  moveClock(86_400_001);
  process.env.TABLE_READ_ONLY = "1";
  await call(describe);
  expect(await db()`SELECT * FROM open_matches`).toHaveLength(1);
  expect(await db()`SELECT * FROM sessions`).toHaveLength(1);
  delete process.env.TABLE_READ_ONLY;
  expect((await call(describe)).status).toBe(200);
  expect(await db()`SELECT * FROM open_matches`).toHaveLength(0);
  expect(await db()`SELECT * FROM sessions`).toHaveLength(0);
  expect(await db()`SELECT * FROM queue`).toHaveLength(0);
  expect(
    (
      await db()`SELECT body FROM events WHERE match_id=${id} ORDER BY seq DESC LIMIT 1`
    )[0]?.body.body.kind,
  ).toBe("end");
});
it("releases dead players for new games without changing history or removing newer occupancy", async () => {
  const old = await db().begin((tx) => startMatch(tx, players));
  const dead = await withMatch(old, async (s) => ({
    events: [],
    value: s.players.find((p) => s.roles[p] === "village") as string,
  }));
  const token = await sessionFor(dead);
  for (const p of players) await submit(old, p, { kind: "ready", turn: 1 });
  for (const p of players)
    await submit(old, p, {
      kind: "vote",
      turn: 2,
      target: p === dead ? null : dead,
    });
  expect(
    (await db()`SELECT players FROM open_matches WHERE match_id=${old}`)[0]
      ?.players,
  ).not.toContain(dead);
  expect(
    (await db()`SELECT players FROM matches WHERE id=${old}`)[0]?.players,
  ).toEqual(players);
  moveClock(7_200_000);
  const tokens = [
    token,
    ...(await Promise.all(
      Array.from({ length: 6 }, (_, i) => sessionFor(`newbot${i}`)),
    )),
  ];
  await Promise.all(
    tokens.map((session) => call(queue, { session, method: "POST" })),
  );
  const current = (await call(me, { session: token })).body.match;
  expect(current).not.toBe(old);
  expect(current).toMatch(/^m_/);
  await sweep();
  expect((await call(me, { session: token })).body.match).toBe(current);
  expect(
    (await db()`SELECT players FROM open_matches WHERE match_id=${current}`)[0]
      ?.players,
  ).toContain(dead);
  expect(
    (await db()`SELECT players FROM matches WHERE id=${old}`)[0]?.players,
  ).toEqual(players);
  expect(
    await db()`SELECT * FROM open_matches WHERE match_id=${old}`,
  ).toHaveLength(0);
});
it("starts a new match after its queue-lock wait, not at transaction start", async () => {
  const tokens = await Promise.all(players.map((p) => sessionFor(p)));
  for (const token of tokens.slice(0, -1))
    await call(queue, { session: token, method: "POST" });
  let pending: ReturnType<typeof call> | undefined;
  let releaseTime = 0;
  await db().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(7402001)`;
    pending = call(queue, { session: tokens.at(-1), method: "POST" });
    await vi.waitFor(async () => {
      const [row] =
        await tx`SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND objid=7402001 AND NOT granted`;
      expect(row?.n).toBe(1);
    });
    const [row] = await tx<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
    releaseTime = (row?.t as Date).getTime();
  });
  const response = await pending;
  expect(response?.status).toBe(200);
  const [row] =
    await db()`SELECT body FROM events WHERE match_id=${response?.body.match} AND seq=0`;
  expect(Date.parse(row?.body.body.at)).toBeGreaterThanOrEqual(releaseTime);
});

it("counts transaction time before a deadline-crossing lock wait", async () => {
  const token = await sessionFor("alice");
  const id = "m_aaaaaaaaaaaa";
  await db().begin(async (tx) => {
    const [row] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
    const events = start(
      players,
      {
        players: 7,
        reveal_on_death: true,
        talk_seconds: 1,
        vote_seconds: 60,
        max_days: 20,
      },
      row?.at as Date,
    );
    await tx`INSERT INTO matches(id,players) VALUES(${id},${players})`;
    for (const [seq, e] of events.entries())
      await tx`INSERT INTO events(match_id,seq,kind,body) VALUES(${id},${seq},${e.body.kind},${tx.json(e)})`;
  });
  let pending: ReturnType<typeof call> | undefined;
  await db().begin(async (tx) => {
    await tx`SELECT id FROM matches WHERE id=${id} FOR UPDATE`;
    pending = call(action, {
      session: token,
      params: { id },
      body: { kind: "ready", turn: 1 },
    });
    await vi.waitFor(async () => {
      const rows =
        await db()`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM matches%'`;
      expect(rows.length).toBeGreaterThan(0);
    });
    await tx`SELECT pg_sleep(1.1)`;
  });
  expect((await pending)?.status).toBe(200);
  expect(
    (
      await call(action, {
        session: token,
        params: { id },
        body: { kind: "ready", turn: 1 },
      })
    ).status,
  ).toBe(409);
  const rows =
    await db()`SELECT body FROM events WHERE match_id=${id} ORDER BY seq`;
  const times = rows.map((r) => Date.parse(r.body.body.at));
  expect(times).toEqual([...times].sort((a, b) => a - b));
});
it("clamps an older waiting transaction to the latest committed event timestamp", async () => {
  const token = await sessionFor("alice");
  const id = await db().begin((tx) => startMatch(tx, players));
  let pending: ReturnType<typeof call> | undefined;
  await db().begin(async (tx) => {
    await tx`SELECT id FROM matches WHERE id=${id} FOR UPDATE`;
    pending = call(action, {
      session: token,
      params: { id },
      body: { kind: "ready", turn: 1 },
    });
    await vi.waitFor(async () => {
      const rows =
        await db()`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM matches%'`;
      expect(rows.length).toBeGreaterThan(0);
    });
    const [row] = await tx<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
    const event = {
      audience: "public",
      body: {
        kind: "talk",
        at: (row?.t as Date).toISOString(),
        player: "bobby",
        text: "a later transaction won the lock",
      },
    };
    await tx`INSERT INTO events(match_id,seq,kind,body) VALUES(${id},8,'talk',${tx.json(event)})`;
  });
  expect((await pending)?.status).toBe(200);
  const rows =
    await db()`SELECT body FROM events WHERE match_id=${id} ORDER BY seq`;
  const times = rows.map((r) => Date.parse(r.body.body.at));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(rows.at(-1)?.body.body.kind).toBe("ready");
});

it("the database rejects duplicate seats", async () => {
  await expect(
    db()`INSERT INTO matches(id,players) VALUES('m_aaaaaaaaaaaa',${Array(7).fill("alice")})`,
  ).rejects.toThrow();
});
