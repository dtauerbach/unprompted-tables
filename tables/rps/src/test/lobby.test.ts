import { afterEach, beforeEach, expect, it } from "vitest";
import { GET as lobbyRoute } from "@/app/v1/lobby/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as queueRoute } from "@/app/v1/queue/route";
import { GET as describeRoute } from "@/app/v1/route";
import { moveClock } from "@/lib/clock";
import { call, countRows, resetDb, sessionFor } from "./helpers";

// A seat lasts 180 seconds after its player last checked in, so a player
// who wandered off is never paired.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});

const player = async (handle: string) => ({
  handle,
  session: await sessionFor(handle),
});
type Player = Awaited<ReturnType<typeof player>>;
const queue = (p: Player) => call(queueRoute, { session: p.session, body: {} });
const me = (p: Player) => call(meRoute, { session: p.session });
const lobby = async () => (await call(lobbyRoute)).body.lobby;

it("shows who is waiting, and says how pairing and seats work", async () => {
  const a = await player("ruby");
  const waiting = await queue(a);
  expect(waiting.body).toMatchObject({
    status: "waiting",
    lobby: { min_players: 2, max_players: 2, seated: ["ruby"], needed: 1 },
  });
  expect(await lobby()).toMatchObject({
    seated: ["ruby"],
    needed: 1,
    starts_at: null,
    hold_seconds: 180,
  });
  const description = (await call(describeRoute)).body;
  expect(description.lobby).toMatchObject({ min_players: 2, max_players: 2 });
  expect(description.endpoints["GET /v1/lobby"]).toBeTruthy();
});

it("needs two players when empty, and two again once a waiting player is paired", async () => {
  expect(await lobby()).toMatchObject({ seated: [], needed: 2 });
  await queue(await player("ruby"));
  await queue(await player("jade"));
  expect(await lobby()).toMatchObject({ seated: [], needed: 2 });
});

it("never pairs a player whose seat lapsed", async () => {
  const a = await player("ruby");
  const b = await player("jade");
  await queue(a);
  moveClock(181_000);
  expect((await me(a)).body.status).toBe("idle");
  expect((await queue(b)).body).toMatchObject({
    status: "waiting",
    lobby: { seated: ["jade"] },
  });
  expect(await countRows("matches")).toBe(0);
});

it("keeps the seat of a player who checks in", async () => {
  const a = await player("ruby");
  const b = await player("jade");
  await queue(a);
  moveClock(150_000);
  const kept = await me(a);
  expect(kept.body.status).toBe("waiting");
  moveClock(150_000);
  const paired = await queue(b);
  expect(paired.status).toBe(200);
  expect((await me(a)).body).toMatchObject({
    status: "playing",
    match: paired.body.match,
  });
});

it("a player whose seat lapsed can join again and is paired with whoever is waiting", async () => {
  const [a, b, c] = [
    await player("ruby"),
    await player("jade"),
    await player("onyx"),
  ];
  await queue(a);
  moveClock(181_000);
  await queue(b);
  // ruby's old seat is gone; joining again takes a new one, behind jade.
  const back = await queue(a);
  expect(back.status).toBe(200);
  expect(await lobby()).toMatchObject({ seated: [] });
  expect((await queue(c)).body.lobby.seated).toEqual(["onyx"]);
});

it("in read-only mode doesn't keep a seat by checking in", async () => {
  const a = await player("ruby");
  await queue(a);
  process.env.TABLE_READ_ONLY = "1";
  moveClock(100_000);
  await me(a);
  delete process.env.TABLE_READ_ONLY;
  moveClock(81_000);
  expect((await me(a)).body.status).toBe("idle");
});
