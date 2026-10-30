import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GET as lobbyRoute } from "@/app/v1/lobby/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as leave } from "@/app/v1/queue/leave/route";
import { POST as queue } from "@/app/v1/queue/route";
import { GET as describe } from "@/app/v1/route";
import { moveClock } from "@/lib/clock";
import { call, resetDb, sessionFor } from "./helpers";

// The test setup seats 5 to 7 with a 120-second fill timer; a seat lasts
// 180 seconds after its player last checked in.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});

const handles = ["alice", "bobby", "carol", "david", "ellen", "frank", "grace"];

async function players(n: number, from = 0) {
  const out: { handle: string; session: string }[] = [];
  for (const handle of handles.slice(from, from + n))
    out.push({ handle, session: await sessionFor(handle) });
  return out;
}

// One at a time, a second apart, so the order of the line is plain.
async function seat(ps: { session: string }[]) {
  const answers = [];
  for (const p of ps) {
    answers.push(await call(queue, { session: p.session, method: "POST" }));
    moveClock(1000);
  }
  return answers;
}

const lobby = async () => (await call(lobbyRoute)).body.lobby;

it("shows who is seated and the rules, to anyone", async () => {
  expect(await lobby()).toMatchObject({
    min_players: 5,
    max_players: 7,
    fill_seconds: 120,
    hold_seconds: 180,
    seated: [],
    starts_at: null,
  });
  const ps = await players(4);
  const [first] = await seat(ps);
  expect(first?.status).toBe(202);
  expect(first?.body.lobby).toMatchObject({ seated: ["alice"] });
  const view = await lobby();
  expect(view.seated).toEqual(["alice", "bobby", "carol", "david"]);
  expect(view.starts_at).toBeNull();
  const description = (await call(describe)).body;
  expect(description.seats).toEqual([{ role: "player", min: 5, max: 7 }]);
  expect(description.settings.lobby).toMatchObject({ min_players: 5 });
});

it("starts the fill timer at the minimum, and starts with whoever is seated when it runs out", async () => {
  const ps = await players(5);
  const answers = await seat(ps);
  const fifth = answers.at(-1)?.body;
  expect(fifth.status).toBe("waiting");
  const startsAt = new Date(fifth.lobby.starts_at).getTime();
  expect(fifth.lobby.seated).toHaveLength(5);
  // The timer runs from the fifth seat, which was taken four seconds in.
  expect(startsAt - new Date(fifth.until).getTime()).toBe(120_000 - 180_000);

  moveClock(110_000);
  for (const p of ps)
    expect((await call(me, { session: p.session })).body.status).toBe(
      "waiting",
    );
  moveClock(10_000);
  const started = await call(me, { session: ps[2]?.session });
  expect(started.body.status).toBe("playing");
  const id = started.body.match as string;
  for (const p of ps)
    expect((await call(me, { session: p.session })).body).toMatchObject({
      status: "playing",
      match: id,
    });
  const state = (
    await call(getMatch, { session: ps[0]?.session, params: { id } })
  ).body;
  expect([...state.players].sort()).toEqual(ps.map((p) => p.handle).sort());
  const roles = await db()`
    SELECT body->'body'->>'side' AS side FROM events
    WHERE match_id = ${id} AND kind = 'role'`;
  expect(roles.filter((r) => r.side === "mafia")).toHaveLength(1);
  expect(await lobby()).toMatchObject({ seated: [], starts_at: null });
});

it("starts at once when full, and the next player waits for the next lobby", async () => {
  const ps = await players(7);
  const answers = await seat(ps);
  expect(answers.at(-1)?.status).toBe(200);
  const id = answers.at(-1)?.body.match as string;
  const roles = await db()`
    SELECT body->'body'->>'side' AS side FROM events
    WHERE match_id = ${id} AND kind = 'role'`;
  expect(roles.filter((r) => r.side === "mafia")).toHaveLength(2);
  const late = { session: await sessionFor("henry") };
  const answer = await call(queue, { session: late.session, method: "POST" });
  expect(answer.body).toMatchObject({
    status: "waiting",
    lobby: { seated: ["henry"], starts_at: null },
  });
});

it("gives up the seat of a player who stops checking in, and seats them at the back if they return", async () => {
  const ps = await players(4);
  await seat(ps);
  moveClock(100_000);
  for (const p of ps.slice(1)) await call(me, { session: p.session });
  moveClock(80_000);
  // alice's seat ran out 180 seconds after she took it; the rest checked in.
  expect((await call(me, { session: ps[0]?.session })).body.status).toBe(
    "idle",
  );
  expect((await lobby()).seated).toEqual(["bobby", "carol", "david"]);
  // Checking in doesn't bring a lapsed seat back; joining again does, last.
  const back = await call(queue, { session: ps[0]?.session, method: "POST" });
  expect(back.body.lobby.seated).toEqual(["bobby", "carol", "david", "alice"]);
  expect(back.body.lobby.starts_at).toBeNull();
});

it("counts only seats still held when it is due, so a lapsed seat is never dealt in", async () => {
  const ps = await players(6);
  await seat(ps.slice(0, 5));
  // ellen took the fifth seat four seconds in, so the timer was due at 124
  // seconds. Nobody checked in then; the others check in at 105 and frank
  // joins.
  moveClock(100_000);
  for (const p of ps.slice(0, 4)) await call(me, { session: p.session });
  await seat(ps.slice(5));
  // At 190 seconds ellen's seat has lapsed. The timer still stands, so the
  // next check-in starts the match with the five seats still held.
  moveClock(85_000);
  const answer = await call(me, { session: ps[0]?.session });
  expect(answer.body.status).toBe("playing");
  const state = (
    await call(getMatch, {
      session: ps[0]?.session,
      params: { id: answer.body.match },
    })
  ).body;
  expect([...state.players].sort()).toEqual(
    ["alice", "bobby", "carol", "david", "frank"].sort(),
  );
  expect((await call(me, { session: ps[4]?.session })).body.status).toBe(
    "idle",
  );
});

it("keeps the fill timer when a player leaves, and waits while below the minimum", async () => {
  const ps = await players(6);
  await seat(ps);
  const before = (await lobby()).starts_at;
  await call(leave, { session: ps[0]?.session, method: "POST" });
  expect((await lobby()).starts_at).toBe(before);
  await call(leave, { session: ps[1]?.session, method: "POST" });
  expect((await lobby()).starts_at).toBeNull();
  moveClock(600_000);
  expect((await call(me, { session: ps[2]?.session })).body.status).toBe(
    "idle",
  );
});

it("can't be held back by the player in the last seat leaving and joining again", async () => {
  const ps = await players(5);
  await seat(ps);
  const startsAt = (await lobby()).starts_at;
  const ellen = ps[4] as { session: string };
  for (let i = 0; i < 4; i++) {
    moveClock(25_000);
    await call(leave, { session: ellen.session, method: "POST" });
    expect((await lobby()).starts_at).toBeNull();
    const back = await call(queue, { session: ellen.session, method: "POST" });
    expect(back.body.lobby.starts_at).toBe(startsAt);
  }
  // 104 seconds in; the timer runs out at 124.
  moveClock(20_000);
  const answer = await call(me, { session: ps[0]?.session });
  expect(answer.body.status).toBe("playing");
  expect((await call(me, { session: ellen.session })).body).toMatchObject({
    status: "playing",
    match: answer.body.match,
  });
});

it("starts the timer afresh once the lobby has emptied", async () => {
  const ps = await players(5);
  await seat(ps);
  for (const p of ps) await call(leave, { session: p.session, method: "POST" });
  moveClock(300_000);
  const answers = await seat(ps);
  const lobbyNow = answers.at(-1)?.body.lobby;
  expect(lobbyNow.seated).toHaveLength(5);
  expect(
    new Date(lobbyNow.starts_at).getTime() -
      new Date(answers.at(-1)?.body.until).getTime(),
  ).toBe(120_000 - 180_000);
});

it("keeps the place in line of a player who joins again while still seated", async () => {
  const ps = await players(3);
  await seat(ps);
  const again = await call(queue, { session: ps[0]?.session, method: "POST" });
  expect(again.body.lobby.seated).toEqual(["alice", "bobby", "carol"]);
});

it("writes nothing on a check-in while the seat has more than half its time left", async () => {
  const ps = await players(2);
  await seat(ps);
  const until = async () =>
    (
      (await db()`SELECT expires_at FROM queue WHERE player = 'alice'`) as unknown as [
        { expires_at: Date },
      ]
    )[0].expires_at.getTime();
  const first = await until();
  moveClock(30_000);
  expect((await call(me, { session: ps[0]?.session })).body.status).toBe(
    "waiting",
  );
  expect(await until()).toBe(first);
  moveClock(70_000);
  await call(me, { session: ps[0]?.session });
  expect(await until()).toBeGreaterThan(first);
});

it("in read-only mode shows the lobby but neither keeps seats nor starts a match", async () => {
  const ps = await players(5);
  await seat(ps);
  process.env.TABLE_READ_ONLY = "1";
  moveClock(130_000);
  const answer = await call(me, { session: ps[0]?.session });
  expect(answer.body.status).toBe("waiting");
  expect((await lobby()).seated).toHaveLength(5);
  expect(await db()`SELECT * FROM matches`).toHaveLength(0);
  const [{ expires_at }] = (await db()`
    SELECT expires_at FROM queue WHERE player = 'alice'`) as unknown as [
    { expires_at: Date },
  ];
  expect(expires_at.getTime()).toBe(new Date(answer.body.until).getTime());
});

it("starts one match however many players check in at the moment it is due", async () => {
  const ps = await players(6);
  await seat(ps);
  moveClock(120_000);
  const answers = await Promise.all(
    ps.map((p) => call(me, { session: p.session })),
  );
  const ids = new Set(answers.map((a) => a.body.match));
  expect(ids.size).toBe(1);
  expect(await db()`SELECT * FROM matches`).toHaveLength(1);
});
