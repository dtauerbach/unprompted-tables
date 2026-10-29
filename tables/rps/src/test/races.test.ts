import { sealOf } from "@unprompted-tables/game";
import { db } from "@unprompted-tables/server";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as commitRoute } from "@/app/v1/matches/[id]/commit/route";
import { POST as revealRoute } from "@/app/v1/matches/[id]/reveal/route";
import { GET as matchRoute } from "@/app/v1/matches/[id]/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as leaveRoute } from "@/app/v1/queue/leave/route";
import { POST as queueRoute } from "@/app/v1/queue/route";
import { GET as standingsRoute } from "@/app/v1/standings/route";
import { moveClock } from "@/lib/clock";
import { sealFields } from "@/lib/match";
import { COMMIT_SECONDS } from "@/lib/settings";
import { call, countRows, resetDb, sessionFor } from "./helpers";

// Two players acting at once, people watching while they play, and clocks
// that run out while nobody looks.

type P = { handle: string; session: string };
beforeEach(resetDb);

const salt = (p: P, r: number) => `salt-${p.handle}-${r}-0000000000`;
const seal = (id: string, r: number, p: P, m: string) =>
  sealOf(sealFields(id, r, p.handle, m, salt(p, r)));
const commit = (id: string, p: P, r: number, m: string) =>
  call(commitRoute, {
    session: p.session,
    params: { id },
    body: { round: r, seal: seal(id, r, p, m) },
  });
const reveal = (id: string, p: P, r: number, m: string) =>
  call(revealRoute, {
    session: p.session,
    params: { id },
    body: { round: r, move: m, salt: salt(p, r) },
  });
const look = async (id: string) =>
  (await call(matchRoute, { params: { id } })).body.match;

async function pair() {
  const a = { handle: "ruby", session: await sessionFor("ruby") };
  const b = { handle: "jade", session: await sessionFor("jade") };
  await call(queueRoute, { session: a.session, body: {} });
  const res = await call(queueRoute, { session: b.session, body: {} });
  return { id: res.body.match as string, a, b };
}

const kinds = async (id: string) =>
  (
    await db()<{ kind: string }[]>`
      SELECT kind FROM events WHERE match_id = ${id} ORDER BY seq`
  ).map((e) => e.kind);

describe("players acting at once", () => {
  it("both committing opens the reveal once", async () => {
    const { id, a, b } = await pair();
    const both = await Promise.all([
      commit(id, a, 1, "rock"),
      commit(id, b, 1, "paper"),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect((await look(id)).phase).toBe("reveal");
    expect(await kinds(id)).toEqual(["start", "commit", "commit"]);
  });

  it("both revealing makes one round, and the last makes one result", async () => {
    const { id, a, b } = await pair();
    for (const r of [1, 2]) {
      await commit(id, a, r, "rock");
      await commit(id, b, r, "scissors");
      const both = await Promise.all([
        reveal(id, a, r, "rock"),
        reveal(id, b, r, "scissors"),
      ]);
      expect(both.map((x) => x.status)).toEqual([200, 200]);
    }
    const k = await kinds(id);
    expect(k.filter((x) => x === "round")).toHaveLength(2);
    expect(k.filter((x) => x === "end")).toHaveLength(1);
    expect(await countRows("results")).toBe(1);
    expect(await countRows("open_matches")).toBe(0);
  });

  it("one player committing twice at once seals only one move", async () => {
    const { id, a } = await pair();
    const twice = await Promise.all([
      commit(id, a, 1, "rock"),
      commit(id, a, 1, "paper"),
    ]);
    expect(twice.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await kinds(id)).toEqual(["start", "commit"]);
  });

  it("a look at the deadline never lets a late commit in", async () => {
    const { id, a, b } = await pair();
    await commit(id, a, 1, "rock");
    moveClock(COMMIT_SECONDS * 1000);
    const [, late] = await Promise.all([
      call(matchRoute, { params: { id } }),
      commit(id, b, 1, "paper"),
    ]);
    expect(late.status).toBe(409);
    expect(await look(id)).toMatchObject({
      round: 2,
      wins: { ruby: 1, jade: 0 },
    });
    expect(await kinds(id)).toEqual(["start", "commit", "timeout", "round"]);
  });
});

describe("watching a match", () => {
  it("doesn't wait on the players while nothing has run out", async () => {
    const { id } = await pair();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    // A player's move holding the match's lock.
    const locked = db().begin(async (tx) => {
      await tx`SELECT id FROM matches WHERE id = ${id} FOR UPDATE`;
      await held;
    });
    const seen = await Promise.race([
      look(id),
      new Promise((r) => setTimeout(() => r("waited"), 2000)),
    ]);
    release();
    await locked;
    expect(seen).toMatchObject({ id, phase: "commit" });
  });

  it("stores what ran out the first time anyone looks", async () => {
    const { id } = await pair();
    moveClock(COMMIT_SECONDS * 1000 + 1);
    expect(await look(id)).toMatchObject({
      phase: "over",
      outcome: "abandoned",
    });
    expect(await kinds(id)).toEqual(["start", "timeout", "end"]);
    expect(await look(id)).toMatchObject({ phase: "over" });
    expect(await kinds(id)).toHaveLength(3);
  });
});

describe("the clock while nobody looks", () => {
  it("closes a phase as soon as its deadline passes, even after a lone commit", async () => {
    const { id, a } = await pair();
    moveClock(50_000);
    await commit(id, a, 1, "rock");
    moveClock(10_001); // just past the commit deadline
    await call(standingsRoute, { path: "/v1/standings" });
    expect(await kinds(id)).toEqual(["start", "commit", "timeout", "round"]);
  });

  it("keeps one row per open match with its next deadline, and drops it at the end", async () => {
    const { id, a, b } = await pair();
    const due = async () =>
      (
        await db()<{ due: Date }[]>`
          SELECT due FROM open_matches WHERE match_id = ${id}`
      )[0]?.due.toISOString();
    expect(await due()).toBe((await look(id)).due);
    await commit(id, a, 1, "rock");
    await commit(id, b, 1, "paper");
    expect(await due()).toBe((await look(id)).due);
    moveClock(10 * 60_000);
    await look(id);
    expect(await due()).toBeUndefined();
    expect((await look(id)).phase).toBe("over");
  });

  it("clears sessions and waits that ran out", async () => {
    const a = { handle: "ruby", session: await sessionFor("ruby") };
    await call(queueRoute, { session: a.session, body: {} });
    expect(await countRows("queue")).toBe(1);
    moveClock(2 * 86_400_000);
    await call(standingsRoute, { path: "/v1/standings" });
    expect(await countRows("queue")).toBe(0);
    expect(await countRows("sessions")).toBe(0);
  });
});

describe("leaving the queue", () => {
  it("doesn't leave a match, and says so", async () => {
    const { id, a } = await pair();
    const res = await call(leaveRoute, { session: a.session, body: {} });
    expect(res.body).toEqual({ player: "ruby", status: "playing", match: id });
    expect((await call(meRoute, { session: a.session })).body.status).toBe(
      "playing",
    );
  });
});

describe("the event log", () => {
  it("refuses an event whose body disagrees with its kind or has no time", async () => {
    const { id } = await pair();
    await expect(
      db()`INSERT INTO events (match_id, seq, kind, body)
           VALUES (${id}, 1, 'end', ${db().json({ kind: "commit", at: "x" })})`,
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO events (match_id, seq, kind, body)
           VALUES (${id}, 1, 'end', ${db().json({ kind: "end" })})`,
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO events (match_id, seq, kind, body)
           VALUES (${id}, 1, 'end', ${db().json({ kind: "end", at: null })})`,
    ).rejects.toThrow();
    expect(await kinds(id)).toEqual(["start"]);
  });
});
