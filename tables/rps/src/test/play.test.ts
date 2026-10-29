import { sealOf } from "@unprompted-tables/game";
import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as commitRoute } from "@/app/v1/matches/[id]/commit/route";
import { POST as revealRoute } from "@/app/v1/matches/[id]/reveal/route";
import { GET as matchRoute } from "@/app/v1/matches/[id]/route";
import { GET as matchesRoute } from "@/app/v1/matches/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as leaveRoute } from "@/app/v1/queue/leave/route";
import { POST as queueRoute } from "@/app/v1/queue/route";
import { GET as standingsRoute } from "@/app/v1/standings/route";
import { moveClock } from "@/lib/clock";
import { LIMITS } from "@/lib/limits";
import { sealFields } from "@/lib/match";
import { COMMIT_SECONDS, REVEAL_SECONDS } from "@/lib/settings";
import { call, countRows, resetDb, sessionFor } from "./helpers";

type Player = { handle: string; session: string };

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});

async function player(handle: string): Promise<Player> {
  return { handle, session: await sessionFor(handle) };
}

const queue = (p: Player) => call(queueRoute, { session: p.session, body: {} });
const look = (id: string) => call(matchRoute, { params: { id } });
const me = (p: Player) => call(meRoute, { session: p.session });

function salt(p: Player, round: number): string {
  return `salt-${p.handle}-${round}-0000000000`;
}

function seal(id: string, round: number, p: Player, move: string): string {
  return sealOf(sealFields(id, round, p.handle, move, salt(p, round)));
}

const commit = (id: string, p: Player, body: unknown) =>
  call(commitRoute, { session: p.session, params: { id }, body });
const reveal = (id: string, p: Player, body: unknown) =>
  call(revealRoute, { session: p.session, params: { id }, body });

async function pair(): Promise<{ id: string; a: Player; b: Player }> {
  const a = await player("ruby");
  const b = await player("jade");
  expect((await queue(a)).status).toBe(202);
  const res = await queue(b);
  expect(res.status).toBe(200);
  return { id: res.body.match, a, b };
}

async function round(
  id: string,
  n: number,
  [a, am]: [Player, string],
  [b, bm]: [Player, string],
) {
  expect(
    (await commit(id, a, { round: n, seal: seal(id, n, a, am) })).status,
  ).toBe(200);
  expect(
    (await commit(id, b, { round: n, seal: seal(id, n, b, bm) })).status,
  ).toBe(200);
  expect(
    (await reveal(id, a, { round: n, move: am, salt: salt(a, n) })).status,
  ).toBe(200);
  const last = await reveal(id, b, { round: n, move: bm, salt: salt(b, n) });
  expect(last.status).toBe(200);
  return last.body.match;
}

describe("pairing", () => {
  it("pairs a player with whoever waited longest, one match each", async () => {
    const [a, b, c] = [
      await player("ruby"),
      await player("jade"),
      await player("onyx"),
    ];
    const first = await queue(a);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ player: "ruby", status: "waiting" });
    // Joining again only keeps your place.
    expect((await queue(a)).body.status).toBe("waiting");
    const second = await queue(b);
    expect(second.body.status).toBe("playing");
    const m = await look(second.body.match);
    expect(m.body.match).toMatchObject({
      players: ["ruby", "jade"],
      round: 1,
      phase: "commit",
    });
    expect((await me(a)).body).toEqual({
      player: "ruby",
      status: "playing",
      match: second.body.match,
    });
    // In a match, joining the queue only says which.
    expect((await queue(a)).body.match).toBe(second.body.match);
    expect((await queue(c)).body.status).toBe("waiting");
    expect(await countRows("matches")).toBe(1);
  });

  it("lets a player leave the queue, and lets a wait run out", async () => {
    const a = await player("ruby");
    const b = await player("jade");
    await queue(a);
    expect(
      (await call(leaveRoute, { session: a.session, body: {} })).status,
    ).toBe(200);
    expect((await queue(b)).body.status).toBe("waiting");
    moveClock(601_000);
    expect((await me(b)).body.status).toBe("idle");
    expect((await queue(a)).body.status).toBe("waiting");
  });

  it("puts everyone joining at once in at most one match", async () => {
    const players = await Promise.all(
      Array.from({ length: 9 }, (_, i) => player(`bot${i}`)),
    );
    await Promise.all(players.map(queue));
    const matches = await db()<
      { players: string[] }[]
    >`SELECT players FROM matches`;
    expect(matches).toHaveLength(4);
    const seated = matches.flatMap((m) => m.players);
    expect(new Set(seated).size).toBe(8);
    expect(await countRows("queue")).toBe(1);
  });
});

describe("a match", () => {
  it("plays to the end, records a result, and shows in the standings", async () => {
    const { id, a, b } = await pair();
    await round(id, 1, [a, "rock"], [b, "scissors"]);
    await round(id, 2, [a, "paper"], [b, "paper"]);
    const end = await round(id, 3, [a, "scissors"], [b, "paper"]);
    expect(end).toMatchObject({
      phase: "over",
      outcome: "won",
      winner: "ruby",
      wins: { ruby: 2, jade: 0 },
      round: null,
      due: null,
    });
    expect(end.events.map((e: { kind: string }) => e.kind)).toEqual([
      "start",
      ...Array(3)
        .fill(["commit", "commit", "reveal", "reveal", "round"])
        .flat(),
      "end",
    ]);
    const [row] = await db()<{ result: unknown }[]>`SELECT result FROM results`;
    expect(row?.result).toMatchObject({
      game: "rps",
      match: id,
      players: [
        { player: "ruby", place: 1 },
        { player: "jade", place: 2 },
      ],
    });
    const s = await call(standingsRoute, { path: "/v1/standings" });
    expect(
      s.body.standings.rows.map((r: { player: string }) => r.player),
    ).toEqual(["ruby", "jade"]);
    // Both are free to play again.
    expect((await me(a)).body.status).toBe("idle");
    const list = await call(matchesRoute, { path: "/v1/matches?player=jade" });
    expect(list.body.matches).toMatchObject([{ id, over: true }]);
  });

  it("closes a phase that ran out when anyone next looks", async () => {
    const { id, a } = await pair();
    await commit(id, a, { round: 1, seal: seal(id, 1, a, "rock") });
    moveClock(COMMIT_SECONDS * 1000);
    const m = (await look(id)).body.match;
    expect(m).toMatchObject({ round: 2, wins: { ruby: 1, jade: 0 } });
    expect(m.events.at(-2)).toMatchObject({ kind: "timeout", missed: [1] });
    // And it was stored, not only shown.
    expect(await countRows("events")).toBe(4);
  });

  it("abandons a match nobody plays, with no result, and frees its players", async () => {
    const { id, a, b } = await pair();
    moveClock(COMMIT_SECONDS * 1000);
    // Nobody looked at the match; joining the queue brings it up to date.
    expect((await queue(a)).body.status).toBe("waiting");
    expect((await look(id)).body.match.outcome).toBe("abandoned");
    expect(await countRows("results")).toBe(0);
    expect((await queue(b)).body.status).toBe("playing");
  });

  it("brings forgotten matches up to date for the standings", async () => {
    const { id, a } = await pair();
    await commit(id, a, { round: 1, seal: seal(id, 1, a, "rock") });
    moveClock(COMMIT_SECONDS * 1000);
    await commit(id, a, { round: 2, seal: seal(id, 2, a, "rock") });
    moveClock(COMMIT_SECONDS * 1000);
    // Nobody has looked since jade's second miss.
    const s = await call(standingsRoute, { path: "/v1/standings" });
    expect(s.body.standings.rows[0]).toMatchObject({ player: "ruby", won: 1 });
  });

  it("shows the clock's work but stores nothing while read-only", async () => {
    const { id } = await pair();
    moveClock(COMMIT_SECONDS * 1000);
    process.env.TABLE_READ_ONLY = "1";
    expect((await look(id)).body.match.outcome).toBe("abandoned");
    expect(await countRows("events")).toBe(1);
  });
});

describe("cheating", () => {
  it("can't move in someone else's match, or as someone else", async () => {
    const { id, a } = await pair();
    const mallory = await player("mallory");
    const res = await commit(id, mallory, {
      round: 1,
      seal: seal(id, 1, mallory, "rock"),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_seated");
    // The player comes from the session, never the body.
    for (const body of [
      { round: 1, seal: seal(id, 1, a, "rock"), player: "ruby" },
      { round: 1, seal: seal(id, 1, a, "rock"), seat: 0 },
    ])
      expect((await commit(id, mallory, body)).status).toBe(400);
    expect(
      (await commit(id, a, { round: 1, seal: "a".repeat(64) })).status,
    ).toBe(200);
    // No session, no move.
    expect(
      (
        await call(commitRoute, {
          params: { id },
          body: { round: 1, seal: "a".repeat(64) },
        })
      ).status,
    ).toBe(401);
  });

  it("can't change a seal, reveal early, or reveal something else", async () => {
    const { id, a, b } = await pair();
    await commit(id, a, { round: 1, seal: seal(id, 1, a, "rock") });
    const early = await reveal(id, a, {
      round: 1,
      move: "rock",
      salt: salt(a, 1),
    });
    expect(early.body.error.code).toBe("wrong_phase");
    const change = await commit(id, a, {
      round: 1,
      seal: seal(id, 1, a, "paper"),
    });
    expect(change.body.error.code).toBe("already_committed");
    await commit(id, b, { round: 1, seal: seal(id, 1, b, "rock") });
    const lie = await reveal(id, a, {
      round: 1,
      move: "paper",
      salt: salt(a, 1),
    });
    expect(lie.status).toBe(400);
    expect(lie.body.error.code).toBe("bad_reveal");
    for (const body of [
      { round: 1, move: "lizard", salt: salt(a, 1) },
      { round: 1, move: "rock" },
      { round: "1", move: "rock", salt: salt(a, 1) },
    ])
      expect((await reveal(id, a, body)).status).toBe(400);
    // Refusals stored nothing.
    expect(await countRows("events")).toBe(3);
  });

  it("makes a copied seal worthless", async () => {
    const { id, a, b } = await pair();
    const rubys = seal(id, 1, a, "rock");
    await commit(id, a, { round: 1, seal: rubys });
    await commit(id, b, { round: 1, seal: rubys });
    await reveal(id, a, { round: 1, move: "rock", salt: salt(a, 1) });
    const copy = await reveal(id, b, {
      round: 1,
      move: "rock",
      salt: salt(a, 1),
    });
    expect(copy.body.error.code).toBe("bad_reveal");
    moveClock(REVEAL_SECONDS * 1000);
    expect((await look(id)).body.match.wins).toEqual({ ruby: 1, jade: 0 });
  });

  it("refuses a move after its phase ran out", async () => {
    const { id, a, b } = await pair();
    await commit(id, a, { round: 1, seal: seal(id, 1, a, "rock") });
    moveClock(COMMIT_SECONDS * 1000 + 1);
    const late = await commit(id, b, {
      round: 1,
      seal: seal(id, 1, b, "paper"),
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("wrong_round");
  });

  it("takes one of two seals sent at once", async () => {
    const { id, a } = await pair();
    const results = await Promise.all(
      ["rock", "paper", "scissors", "rock"].map((m) =>
        commit(id, a, { round: 1, seal: seal(id, 1, a, m) }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await countRows("events")).toBe(2);
  });

  it("limits moves, counting only the ones taken", async () => {
    const { id, a } = await pair();
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${`move:${a.handle}`}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600),
              ${LIMITS.movePerPlayer.limit})`;
    const res = await commit(id, a, { round: 1, seal: seal(id, 1, a, "rock") });
    expect(res.status).toBe(429);
    expect(await countRows("events")).toBe(1);
  });

  it("can't rewrite history in the database", async () => {
    const { id, a, b } = await pair();
    await round(id, 1, [a, "rock"], [b, "scissors"]);
    await expect(
      db()`UPDATE events SET body = '{}' WHERE match_id = ${id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`DELETE FROM events WHERE match_id = ${id}`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE matches SET players = ARRAY['jade','ruby']`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db()`INSERT INTO matches (id, players) VALUES ('m_aaaaaaaaaaaa', ARRAY['ruby','ruby'])`,
    ).rejects.toThrow();
    await expect(
      db()`INSERT INTO events (match_id, seq, kind, body) VALUES (${id}, 99, 'end', '{}'), (${id}, 100, 'end', '{}')`,
    ).rejects.toThrow();
  });

  it("answers a match id that isn't one with a plain 404", async () => {
    for (const id of ["m_nope", "../../etc", "m_aaaaaaaaaaaa"]) {
      const res = await look(id);
      expect(res.status, id).toBe(404);
    }
    const p = await player("ruby");
    expect(
      (await commit("m_aaaaaaaaaaaa", p, { round: 1, seal: "a".repeat(64) }))
        .status,
    ).toBe(404);
  });

  it("checks standings and listing inputs", async () => {
    for (const top of ["0", "1001", "-1", "abc", "1e3"])
      expect(
        (await call(standingsRoute, { path: `/v1/standings?top=${top}` }))
          .status,
        top,
      ).toBe(400);
    expect(
      (await call(matchesRoute, { path: "/v1/matches?player=Not A Handle" }))
        .status,
    ).toBe(400);
  });
});
