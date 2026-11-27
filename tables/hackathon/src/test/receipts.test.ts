import { beforeEach, describe, expect, it } from "vitest";
import { POST as actRoute } from "@/app/v1/hackathons/[event]/actions/route";
import { GET as readRoute } from "@/app/v1/hackathons/[event]/route";
import { moveClock } from "@/lib/clock";
import { at, call, countRows, listed, resetDb, sessionFor } from "./helpers";

const MIN = 60_000;

beforeEach(resetDb);

const doing = (session: string | undefined, event: string, body: unknown) =>
  call(actRoute, {
    session,
    body,
    params: { event },
    path: `/v1/hackathons/${event}/actions`,
  });
const read = (session: string | undefined, event: string) =>
  call(readRoute, {
    session,
    params: { event },
    path: `/v1/hackathons/${event}`,
  });

const pins = [{ store: "github", ref: "team/app", revision: "a1b2c3d" }];

// A building hackathon with ada and ben in one team.
async function building() {
  const event = await listed();
  const host = await sessionFor("jam-host");
  const ada = await sessionFor("ada-bot");
  const ben = await sessionFor("ben-bot");
  for (const s of [ada, ben])
    expect((await doing(s, event, { type: "register" })).status).toBe(201);
  await doing(ada, event, { type: "make_team", name: "Owls" });
  await doing(ben, event, { type: "ask", team: 1 });
  await doing(ada, event, { type: "admit", who: "ben-bot" });
  moveClock(61 * MIN);
  return { event, host, ada, ben };
}

describe("receipts over HTTP", () => {
  it("answers a retry with the first receipt and writes nothing", async () => {
    const { event, ben, ada } = await building();
    const body = { type: "submit", title: "Owl app", pins, op: "owl-op-0001" };
    const first = await doing(ben, event, body);
    expect(first.status, first.text).toBe(201);
    expect(first.body.receipt).toMatchObject({
      event,
      team: 1,
      entry: 1,
      op: "owl-op-0001",
      deadline_version: 1,
    });
    const rows = await countRows("events");

    const again = await doing(ben, event, body);
    expect(again.status, again.text).toBe(200);
    expect(again.body.already).toBe(true);
    expect(again.body.receipt).toEqual(first.body.receipt);
    expect(again.body.accepted).toBeUndefined();
    expect(await countRows("events")).toBe(rows);

    // After the deadline, and after leaving, the retry still gets it.
    expect((await doing(ben, event, { type: "leave" })).status).toBe(201);
    moveClock(200 * MIN);
    const late = await doing(ben, event, body);
    expect(late.status).toBe(200);
    expect(late.body.receipt).toEqual(first.body.receipt);
    // A new submission after the deadline is still refused.
    const fresh = await doing(ada, event, { ...body, op: "owl-op-0002" });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe("deadline_passed");
  });

  it("refuses the same op for other work, writing nothing", async () => {
    const { event, ben } = await building();
    await doing(ben, event, {
      type: "submit",
      title: "Owl app",
      pins,
      op: "owl-op-0001",
    });
    const rows = await countRows("events");
    const swapped = await doing(ben, event, {
      type: "submit",
      title: "Owl app",
      pins: [{ ...pins[0], revision: "bad0bad" }],
      op: "owl-op-0001",
    });
    expect(swapped.status).toBe(409);
    expect(swapped.body.error.code).toBe("op_used");
    expect(await countRows("events")).toBe(rows);
  });

  it("lands one of two identical submissions sent at once, and answers the other", async () => {
    const { event, ben } = await building();
    const body = { type: "submit", title: "Owl app", pins, op: "owl-op-0003" };
    const rows = await countRows("events");
    const both = await Promise.all([
      doing(ben, event, body),
      doing(ben, event, body),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(both[0]?.body.receipt).toEqual(both[1]?.body.receipt);
    expect(await countRows("events")).toBe(rows + 1);
  });

  it("answers a retry after the hackathon is called off", async () => {
    const { event, host, ben } = await building();
    const body = { type: "submit", title: "Owl app", pins, op: "owl-op-0004" };
    const first = await doing(ben, event, body);
    expect(first.status).toBe(201);
    expect((await doing(host, event, { type: "cancel" })).status).toBe(201);
    const again = await doing(ben, event, body);
    expect(again.status, again.text).toBe(200);
    expect(again.body.receipt).toEqual(first.body.receipt);
  });

  it("keeps an op to its hackathon", async () => {
    const { event, ada, ben } = await building();
    // Listed now, so already building on the moved clock.
    const other = await listed({ event: "autumn-jam" });
    for (const s of [ada, ben])
      expect((await doing(s, other, { type: "register" })).status).toBe(201);
    await doing(ben, other, { type: "make_team", name: "Larks" });
    const body = { type: "submit", title: "Owl app", pins, op: "owl-op-0005" };
    const one = await doing(ben, event, body);
    const two = await doing(ben, other, body);
    expect(one.status).toBe(201);
    expect(two.status, two.text).toBe(201);
    expect(two.body.receipt).toMatchObject({ event: other, team: 1, entry: 1 });
  });
});

describe("extending over HTTP", () => {
  it("lets the host move the deadline, shows it, and refuses anyone else", async () => {
    const { event, host, ada } = await building();
    const listedDeadline = (await read(undefined, event)).body.hackathon
      .deadline;
    const later = at(400);
    const not = await doing(ada, event, { type: "extend", deadline: later });
    expect(not.status).toBe(403);
    expect(not.body.error.code).toBe("not_host");

    const moved = await doing(host, event, { type: "extend", deadline: later });
    expect(moved.status, moved.text).toBe(201);
    expect(moved.body.receipt).toBeUndefined();
    const v = (await read(undefined, event)).body.hackathon;
    expect(v).toMatchObject({ deadline: later, deadline_version: 2 });
    expect(v.listed_deadline).toBe(listedDeadline);

    // Past the old deadline, building goes on and a submission lands.
    moveClock(200 * MIN);
    const sub = await doing(ada, event, { type: "submit", title: "In", pins });
    expect(sub.status, sub.text).toBe(201);
    expect(sub.body.receipt).toMatchObject({
      deadline: later,
      deadline_version: 2,
    });

    // Too close to the new deadline to move it again.
    moveClock(130 * MIN);
    const tooLate = await doing(host, event, {
      type: "extend",
      deadline: at(600),
    });
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.code).toBe("too_late");
  });
});
