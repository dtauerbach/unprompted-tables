import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as leave } from "@/app/v1/queue/leave/route";
import { POST as queue } from "@/app/v1/queue/route";
import { DELETE as revoke, POST as session } from "@/app/v1/sessions/route";
import { moveClock } from "@/lib/clock";
import { startMatch } from "@/lib/store";
import { call, fakeSite, join, resetDb, sessionFor } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});
const handles = ["alice", "bobby", "carol", "david", "ellen", "frank", "grace"];
async function match() {
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  await Promise.all(
    tokens.map((s) => call(queue, { session: s, method: "POST" })),
  );
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  return { id, tokens, params: { id } };
}
describe("Mafia HTTP with Postgres", () => {
  it("requires identity on writes and exchanges only addressed single-use passes", async () => {
    for (const handler of [action, queue, leave, revoke]) {
      expect(
        (
          await call(handler, {
            method: "POST",
            params: { id: "m_aaaaaaaaaaaa" },
            body: { kind: "ready", turn: 1 },
          })
        ).status,
      ).toBe(401);
    }
    const site = fakeSite();
    try {
      const pass = site.pass("alice");
      const res = await call(session, { body: { pass } });
      expect(res.status).toBe(201);
      expect(res.body.session).toMatch(/^mafia_/);
      expect((await call(session, { body: { pass } })).status).toBe(400);
      const player = await join(site, "bobby");
      expect((await call(me, { session: player.session })).body.player).toBe(
        "bobby",
      );
      expect(JSON.stringify(site.calls)).not.toContain(player.session);
    } finally {
      site.restore();
    }
  });
  it("serializes queue joins, binds sessions to one seat, and persists append-only ordered events", async () => {
    const g = await match();
    const duplicate = await sessionFor("alice");
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(queue, { session: duplicate, method: "POST" }),
      ),
    );
    expect(responses.every((r) => r.body.match === g.id)).toBe(true);
    const rows = await db()`SELECT players FROM matches`;
    expect(rows).toHaveLength(1);
    expect(new Set(rows[0]?.players).size).toBe(7);
    const read = await call(getMatch, { params: g.params });
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(read.body.events).toHaveLength(1);
    const own = await call(getMatch, { params: g.params, session: duplicate });
    expect(
      own.body.events.filter((e: { kind: string }) => e.kind === "role"),
    ).toHaveLength(1);
    expect(JSON.stringify(own.body)).not.toContain('"audience"');
    expect(
      (await call(getMatch, { params: g.params, session: "mafia_invalid" }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(action, {
          params: g.params,
          session: duplicate,
          body: { kind: "ready", turn: 1, player: "bobby" },
        })
      ).status,
    ).toBe(400);
    const races = await Promise.all(
      [1, 2].map(() =>
        call(action, {
          params: g.params,
          session: duplicate,
          body: { kind: "ready", turn: 1 },
        }),
      ),
    );
    expect(races.map((r) => r.status).sort()).toEqual([200, 409]);
    await expect(
      db()`UPDATE events SET kind = 'end' WHERE match_id = ${g.id}`,
    ).rejects.toThrow();
    const events =
      await db()`SELECT seq FROM events WHERE match_id = ${g.id} ORDER BY seq`;
    expect(events.map((e) => e.seq)).toEqual(
      Array.from({ length: 9 }, (_, i) => i),
    );
  });
  it("serializes leaving with a matcher that has selected the queued seat", async () => {
    const token = await sessionFor("alice");
    await call(queue, { session: token, method: "POST" });
    let leaving: ReturnType<typeof call> | undefined;
    let id = "";
    await db().begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(7402001)`;
      // A matcher has selected Alice but not yet committed the match.
      leaving = call(leave, { session: token, method: "POST" });
      await vi.waitFor(async () => {
        const [row] =
          await tx`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 7402001 AND NOT granted`;
        expect(row?.n).toBe(1);
      });
      expect(
        await tx`SELECT player FROM queue WHERE player = 'alice'`,
      ).toHaveLength(1);
      id = await startMatch(tx, handles);
      await tx`DELETE FROM queue WHERE player = 'alice'`;
    });
    const response = await leaving;
    expect(response?.status).toBe(200);
    expect(response?.body.status).toBe("playing");
    expect(response?.body.match).toBe(id);
  });

  it("filters every response, including private writes and reads after game end", async () => {
    const g = await match();
    const sides = await Promise.all(
      g.tokens.map(async (token) => {
        const r = await call(getMatch, { params: g.params, session: token });
        return r.body.events.find((e: { kind: string }) => e.kind === "role")
          .side as string;
      }),
    );
    const mafia = sides.flatMap((s, i) => (s === "mafia" ? [i] : []));
    const villagers = sides.flatMap((s, i) => (s === "village" ? [i] : []));
    const send = (i: number, body: unknown) =>
      call(action, { params: g.params, session: g.tokens[i], body });
    for (let i = 0; i < 7; i++)
      expect((await send(i, { kind: "ready", turn: 1 })).status).toBe(200);
    for (let i = 0; i < 7; i++)
      expect(
        (await send(i, { kind: "vote", turn: 2, target: null })).status,
      ).toBe(200);
    const secret = "<img src=x onerror=steal()> private strategy";
    const privateReply = await send(mafia[0] as number, {
      kind: "talk",
      turn: 3,
      text: secret,
    });
    expect(JSON.stringify(privateReply.body)).toContain(secret);
    for (const i of villagers) {
      expect(
        (await send(i, { kind: "talk", turn: 3, text: "cheat" })).status,
      ).toBe(409);
      expect(
        JSON.stringify(
          (await call(getMatch, { params: g.params, session: g.tokens[i] }))
            .body,
        ),
      ).not.toContain(secret);
    }
    for (const i of mafia) await send(i, { kind: "ready", turn: 3 });
    const victim = villagers[0] as number;
    for (const i of mafia)
      await send(i, { kind: "vote", turn: 4, target: handles[victim] });
    expect((await send(victim, { kind: "ready", turn: 5 })).status).toBe(409);
    const outsider = await sessionFor("outside");
    expect(
      (
        await call(action, {
          params: g.params,
          session: outsider,
          body: { kind: "ready", turn: 5 },
        })
      ).status,
    ).toBe(409);
    moveClock(24 * 3600 * 1000);
    const end = await call(getMatch, { params: g.params });
    expect(end.body.phase).toBe("over");
    expect(JSON.stringify(end.body)).not.toContain(secret);
  });
  it("persists deadlines on read, refuses stale turns and honors read-only without changing history", async () => {
    const g = await match();
    moveClock(120_000);
    expect(
      (
        await call(action, {
          params: g.params,
          session: g.tokens[0],
          body: { turn: 1, kind: "ready" },
        })
      ).status,
    ).toBe(409);
    process.env.TABLE_READ_ONLY = "1";
    const before = await db()`SELECT count(*) FROM events`;
    expect((await call(getMatch, { params: g.params })).body.phase).toBe(
      "day_vote",
    );
    expect(await db()`SELECT count(*) FROM events`).toEqual(before);
    expect(
      (await call(queue, { session: g.tokens[0], method: "POST" })).status,
    ).toBe(503);
    expect(
      (await call(revoke, { session: g.tokens[0], method: "DELETE" })).status,
    ).toBe(200);
    delete process.env.TABLE_READ_ONLY;
    expect((await call(getMatch, { params: g.params })).body.phase).toBe(
      "day_vote",
    );
    expect(Number((await db()`SELECT count(*) AS n FROM events`)[0]?.n)).toBe(
      9,
    );
  });
});
