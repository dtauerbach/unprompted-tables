import { randomBytes } from "node:crypto";
import { db } from "@unprompted-tables/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { GET as skill } from "@/app/skill.md/route";
import { GET as lobbyRoute } from "@/app/v1/lobby/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { GET as describeTable } from "@/app/v1/route";
import { DELETE as endSessionRoute } from "@/app/v1/sessions/route";
import { GET as spectateOne } from "@/app/v1/spectate/[id]/route";
import { GET as spectateList } from "@/app/v1/spectate/route";
import { moveClock, now } from "@/lib/clock";
import { EXECUTIVES, start as startFloor } from "@/lib/floor/game";
import { FLOOR_VARIANTS, type FloorVariant } from "@/lib/floor/variants";
import { seatingResponse } from "@/lib/lab/http";
import { REFUSALS } from "@/lib/lab/page";
import {
  pairSeed,
  ROOM_CLOCKS,
  type Room,
  type RoomsFile,
  setRoomsForTests,
} from "@/lib/lab/rooms";
import { seatOf } from "@/lib/lab/seats";
import { guideFor } from "@/lib/lab/texts";
import { sweep } from "@/lib/store";
import {
  call,
  countRows,
  freshIp,
  holderOf,
  insertMatch,
  resetDb,
  sessionFor,
} from "./helpers";

// Rooms over HTTP, against the database: taking a seat, the code, the
// page and the moves, and what the rest of the Table never shows. Every
// refusal a stranger can meet is the same nothing: the route turns it into
// the 404 of an unknown path, which a test here can only see as null.

const HANDLES = ["lab-one", "lab-two", "lab-three", "lab-four", "lab-five"];
const HOST = "https://seating-desk.vercel.app";
const HIDDEN = "(the 404 of an unknown path)";

// A stand-in for the site: passes it made, used once, and each bot's
// public page, which shows the test mark for the handles in `marked`.
function fakeSite() {
  const passes = new Map<string, string>();
  const marked = new Set(HANDLES);
  const calls: string[] = [];
  let down = false;
  let page: ((handle: string) => Response) | null = null;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (down) throw new TypeError("fetch failed");
      if (url.pathname === "/v1/passes/redeem") {
        const { pass } = JSON.parse(String(init?.body ?? "{}"));
        const handle = passes.get(pass);
        if (!handle)
          return Response.json(
            { error: { code: "invalid_pass" } },
            { status: 400 },
          );
        passes.delete(pass);
        return Response.json({ bot: holderOf(handle) });
      }
      const bot = url.pathname.match(/^\/v1\/bots\/([a-z0-9_-]+)$/)?.[1];
      if (bot && !init?.method) {
        if (page) return page(bot);
        return Response.json({
          bot: { ...holderOf(bot), is_test: marked.has(bot), frozen: false },
          profile: {},
        });
      }
      return Response.json({ error: { code: "nope" } }, { status: 404 });
    });
  return {
    calls,
    marked,
    pass(handle: string): string {
      const p = `pass_${randomBytes(16).toString("base64url")}`;
      passes.set(p, handle);
      return p;
    },
    setDown(v: boolean) {
      down = v;
    },
    setPage(fn: ((handle: string) => Response) | null) {
      page = fn;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

const iso = (msFromNow: number) =>
  new Date(now().getTime() + msFromNow).toISOString();
const MIN = 60_000;

function roomsWith(over: Partial<Room> = {}): RoomsFile {
  const r = (id: string, pair: string, arm: Room["arm"], w: [number, number]) =>
    ({
      id,
      pair,
      arm,
      handles: HANDLES,
      window: { from: iso(w[0]), to: iso(w[1]) },
      clock: "quick" as const,
      ...over,
    }) satisfies Room;
  return {
    about: "rooms for tests",
    host: HOST,
    rooms: [
      r("p1-control", "p1", "control", [-MIN, 60 * MIN]),
      r("p1-treatment", "p1", "treatment", [-MIN, 60 * MIN]),
      r("p2-control", "p2", "control", [10 * MIN, 20 * MIN]),
      r("p2-treatment", "p2", "treatment", [10 * MIN, 20 * MIN]),
      r("p3-control", "p3", "control", [-20 * MIN, -10 * MIN]),
      r("p3-treatment", "p3", "treatment", [-20 * MIN, -10 * MIN]),
    ],
  };
}

let site: ReturnType<typeof fakeSite>;
beforeEach(async () => {
  await resetDb();
  setRoomsForTests(roomsWith());
  site = fakeSite();
});
afterEach(() => {
  site.restore();
  setRoomsForTests(null);
  delete process.env.TABLE_READ_ONLY;
  delete process.env.TABLE_URL;
});

async function seating(
  path: string,
  opts: Parameters<typeof call>[1] & { code?: string; query?: string } = {},
) {
  const parts = path ? path.split("/") : [];
  return call(
    async (req: Request) =>
      (await seatingResponse(req, parts)) ??
      new Response(HIDDEN, { status: 404 }),
    {
      ...opts,
      session: opts.code ?? opts.session,
      path: `/seating${path ? `/${path}` : ""}${opts.query ?? ""}`,
    },
  );
}

const join = (handle: string, room = "p1-control", ip?: string) =>
  seating("seats", { body: { pass: site.pass(handle), room }, ip });

async function seatAll(room = "p1-control"): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  for (const h of HANDLES) {
    const res = await join(h, room);
    expect(res.status, `${h}: ${res.text}`).toBe(201);
    codes.set(h, res.body.code);
  }
  return codes;
}

const roomMatchId = async (room = "p1-control") =>
  (
    await db()<{ match_id: string }[]>`
      SELECT match_id FROM lab_matches WHERE room = ${room}`
  )[0]?.match_id;

const expectHidden = (res: { status: number; text: string }) => {
  expect(res.status).toBe(404);
  expect(res.text).toBe(HIDDEN);
};

describe("taking a seat", () => {
  it("seats a listed, test-marked handle and answers with its guest, its note and the room's neutral address", async () => {
    process.env.TABLE_URL = "https://dinner-table-unprompted1.vercel.app";
    const res = await join("lab-two");
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      "code",
      "note",
      "page",
      "person",
    ]);
    expect(res.body.code).toMatch(/^seat_[A-Za-z0-9_-]{22}$/);
    expect(res.body.page).toBe(HOST);
    const { person, note } = seatOf(roomsWith().rooms[0] as Room, "lab-two");
    expect(res.body).toMatchObject({ person, note });
    expect(EXECUTIVES).toContain(person);
    expect(res.text).not.toMatch(/unprompted|lab-two/i);
    const [row] = await db()`SELECT player, room FROM sessions`;
    expect(row).toEqual({ player: "lab-two", room: "p1-control" });
    // The site was asked to check the pass and read the bot's page, and
    // nothing else.
    expect(site.calls).toEqual([
      "POST /v1/passes/redeem",
      "GET /v1/bots/lab-two",
    ]);
  });

  const refused: [string, () => Promise<unknown>][] = [
    ["no body", () => seating("seats", { method: "POST" })],
    ["not JSON", () => seating("seats", { rawBody: "{" })],
    [
      "an extra field",
      () =>
        seating("seats", {
          body: { pass: site.pass("lab-one"), room: "p1-control", as: "x" },
        }),
    ],
    [
      "no room",
      () => seating("seats", { body: { pass: site.pass("lab-one") } }),
    ],
    ["an unknown room", () => join("lab-one", "p9-control")],
    ["a window not yet open", () => join("lab-one", "p2-control")],
    ["a window closed", () => join("lab-one", "p3-control")],
    [
      "a pass the site never made",
      () =>
        seating("seats", {
          body: { pass: `pass_${"A".repeat(22)}`, room: "p1-control" },
        }),
    ],
    [
      "something that isn't a pass",
      () => seating("seats", { body: { pass: "hello", room: "p1-control" } }),
    ],
    ["a stranger's good pass", () => join("someone-else")],
    [
      "a listed handle without the test mark",
      () => {
        site.marked.delete("lab-three");
        return join("lab-three");
      },
    ],
    [
      "a bot page that's missing",
      () => {
        site.setPage(() => Response.json({}, { status: 404 }));
        return join("lab-three");
      },
    ],
    [
      "a bot page about another bot",
      () => {
        site.setPage(() =>
          Response.json({ bot: { handle: "lab-four", is_test: true } }),
        );
        return join("lab-three");
      },
    ],
    [
      "the site down",
      () => {
        site.setDown(true);
        return join("lab-three");
      },
    ],
    [
      "the kill switch",
      () => {
        process.env.TABLE_READ_ONLY = "1";
        return join("lab-three");
      },
    ],
  ];
  for (const [name, attempt] of refused)
    it(`gives nothing for ${name}`, async () => {
      expectHidden((await attempt()) as never);
      expect(await countRows("sessions")).toBe(0);
      expect(await countRows("lab_matches")).toBe(0);
      expect(await countRows("players")).toBe(0);
    });

  it("gives nothing for a replayed pass", async () => {
    const pass = site.pass("lab-one");
    const body = { pass, room: "p1-control" };
    expect((await seating("seats", { body })).status).toBe(201);
    expectHidden(
      await seating("seats", { body: { ...body, room: "p1-treatment" } }),
    );
    expect(await countRows("sessions")).toBe(1);
  });

  it("gives nothing for a second claim on a taken seat, even with a good pass", async () => {
    const first = await join("lab-one");
    expect(first.status).toBe(201);
    expectHidden(await join("lab-one"));
    expect(await countRows("sessions")).toBe(1);
    // The first code still holds the seat.
    expect((await seating("guide", { code: first.body.code })).status).toBe(
      200,
    );
  });

  it("gives nothing once the room has been played, even for a seat that's free again", async () => {
    await seatAll();
    await db()`DELETE FROM sessions WHERE player = 'lab-one'`;
    expectHidden(await join("lab-one"));
  });

  it("counts every try against the address's session limit, and then spends no pass", async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++)
      expectHidden(
        await seating("seats", {
          body: { pass: `pass_${"B".repeat(22)}`, room: "p1-control" },
          ip,
        }),
      );
    const before = site.calls.length;
    expectHidden(await join("lab-one", "p1-control", ip));
    expect(site.calls.length).toBe(before);
    expect((await join("lab-one", "p1-control", freshIp())).status).toBe(201);
  });

  it("starts the match at the fifth seat, in the room's order, with the pair's seed and clock", async () => {
    for (const h of HANDLES.slice(0, 4))
      expect((await join(h)).status).toBe(201);
    expect(await countRows("lab_matches")).toBe(0);
    expect(await countRows("matches")).toBe(0);
    expect((await join("lab-five")).status).toBe(201);
    const id = (await roomMatchId()) as string;
    expect(id).toBeDefined();
    const [m] = await db()`SELECT players FROM matches WHERE id = ${id}`;
    expect(m?.players).toEqual(HANDLES);
    const events = await db()<{ body: { body: Record<string, unknown> } }[]>`
      SELECT body FROM events WHERE match_id = ${id} ORDER BY seq`;
    const deal = events.find((e) => e.body.body.kind === "deal")?.body.body
      .deal as { seed: string; variant: string };
    expect(deal.seed).toBe(pairSeed("p1"));
    expect(deal.variant).toBe("room-quick");
    // The other room of the pair is still to be played.
    expect(await roomMatchId("p1-treatment")).toBeUndefined();
  });

  it("deals both rooms of a pair alike: the same guest, note and moment", async () => {
    const control = new Map<string, unknown>();
    for (const h of HANDLES) control.set(h, (await join(h, "p1-control")).body);
    for (const h of HANDLES) {
      const t = (await join(h, "p1-treatment")).body;
      const c = control.get(h) as typeof t;
      expect({ person: t.person, note: t.note }).toEqual({
        person: c.person,
        note: c.note,
      });
    }
    const deals = await db()<{ deal: unknown }[]>`
      SELECT e.body->'body'->'deal' AS deal FROM events e
      JOIN lab_matches l ON l.match_id = e.match_id
      WHERE e.kind = 'deal' ORDER BY l.room`;
    expect(deals).toHaveLength(2);
    expect(deals[0]?.deal).toEqual(deals[1]?.deal);
  });

  it("gives a seat back before the start, and not after", async () => {
    const first = await join("lab-one");
    const back = await seating("seats", {
      code: first.body.code,
      method: "DELETE",
    });
    expect(back.status).toBe(200);
    expect(await countRows("sessions")).toBe(0);
    expectHidden(await seating("guide", { code: first.body.code }));
    const codes = await seatAll();
    const late = await seating("seats", {
      code: codes.get("lab-two"),
      method: "DELETE",
    });
    expect(late.status).toBe(409);
    expect(late.body.error).toEqual({
      code: "started",
      message: REFUSALS.started,
    });
    expect(await countRows("sessions")).toBe(5);
  });
});

describe("a seat's code", () => {
  it("works on no ordinary route", async () => {
    const codes = await seatAll();
    const code = codes.get("lab-one") as string;
    const id = (await roomMatchId()) as string;
    for (const res of [
      await call(me, { session: code }),
      await call(queue, { session: code, method: "POST" }),
      await call(getMatch, {
        session: code,
        params: { id },
        path: `/v1/matches/${id}`,
      }),
      await call(action, {
        session: code,
        params: { id },
        body: { kind: "talk", text: "hello" },
      }),
      await call(endSessionRoute, { session: code, method: "DELETE" }),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("invalid_session");
    }
    expect(await countRows("sessions")).toBe(5);
  });

  it("is the only key to /seating: an ordinary session, a bad code or none get nothing", async () => {
    await seatAll();
    const ordinary = await sessionFor("lab-one");
    for (const path of ["", "tick", "guide", "say", "seats"])
      for (const session of [
        undefined,
        ordinary,
        `seat_${"x".repeat(22)}`,
        "seat_short",
      ]) {
        expectHidden(await seating(path, { session }));
        expectHidden(await seating(path, { session, body: { text: "hi" } }));
      }
  });

  it("gets nothing at a path or method the room doesn't have, naming included", async () => {
    const code = (await seatAll()).get("lab-one") as string;
    for (const [path, method] of [
      ["name", "POST"],
      ["seats", "GET"],
      ["say", "GET"],
      ["guide", "POST"],
      ["record", "GET"],
      ["", "PUT"],
      ["", "OPTIONS"],
      ["", "HEAD"],
      ["tick/x", "GET"],
    ] as const)
      expectHidden(
        await seating(path, {
          code,
          method,
          ...(method === "POST" ? { body: {} } : {}),
        }),
      );
  });

  it("gets nothing once it has run out, or once its room is no longer listed", async () => {
    const codes = await seatAll();
    const code = codes.get("lab-one") as string;
    expect((await seating("", { code })).status).toBe(200);
    setRoomsForTests({ ...roomsWith(), rooms: roomsWith().rooms.slice(2) });
    expectHidden(await seating("", { code }));
    setRoomsForTests(roomsWith());
    moveClock(25 * 3_600_000);
    expectHidden(await seating("", { code }));
  });
});

describe("a room in play", () => {
  async function playing() {
    const codes = await seatAll();
    const id = (await roomMatchId()) as string;
    // Who holds which guest, as each seat's page says.
    const byGuest = new Map<string, string>();
    for (const [h, code] of codes) {
      const p = await seating("", { code });
      byGuest.set(p.body.you.seat, h);
    }
    const as = (guest: string) =>
      codes.get(byGuest.get(guest) as string) as string;
    return { codes, id, as, byGuest };
  }

  it("serves the guide, the page and the tick to a seat", async () => {
    const first = await join("lab-one");
    const code = first.body.code as string;
    const guide = await seating("guide", { code });
    expect(guide.status).toBe(200);
    expect(guide.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(guide.text).toBe(
      guideFor({
        arm: "control",
        person: first.body.person,
        variant: ROOM_CLOCKS.quick as FloorVariant,
      }),
    );
    // Before the fifth seat: the seat and its note, and a tick of 0.
    expect((await seating("", { code })).body).toEqual({
      started: false,
      message: REFUSALS.not_started,
      you: { person: first.body.person, note: first.body.note },
    });
    expect((await seating("tick", { code })).body).toEqual({ tick: 0 });
    const said = await seating("say", { code, body: { text: "Hello?" } });
    expect(said.status).toBe(409);
    expect(said.body.error.code).toBe("not_started");
    for (const h of HANDLES.slice(1)) await join(h);
    const page = (await seating("", { code })).body;
    expect(page.you).toMatchObject({
      seat: first.body.person,
      note: first.body.note,
    });
    expect(page.who).toBe(
      "Each of the other four seats is held by that guest's AI assistant.",
    );
    const tick = (await seating("tick", { code })).body.tick;
    expect(tick).toBeGreaterThan(0);
    await seating("say", { code, body: { text: "Good evening." } });
    expect((await seating("tick", { code })).body.tick).toBe(tick + 1);
  });

  it("takes the three moves, and refuses in the room's own words", async () => {
    const { as } = await playing();
    const said = await seating("say", {
      code: as("Avery"),
      body: { text: "Shall we sort the seats?" },
    });
    expect(said.status).toBe(200);
    expect(said.body.talk).toEqual([
      expect.objectContaining({
        seat: "Avery",
        to: null,
        untrusted_text: "Shall we sort the seats?",
      }),
    ]);
    const early = await seating("propose", {
      code: as("Blake"),
      body: { seating: EXECUTIVES },
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_open_yet");
    const toSage = await seating("say", {
      code: as("Blake"),
      body: { text: "Hi", to: "Sage" },
    });
    expect([toSage.status, toSage.body.error.code]).toEqual([
      400,
      "unknown_seat",
    ]);
    for (const body of [
      { kind: "name", executive: "Casey", dislikes: "Avery" },
      { text: "hi", kind: "talk" },
      { text: "hi", to: ["Casey"] },
    ]) {
      const odd = await seating("say", { code: as("Blake"), body });
      expect([odd.status, odd.body.error.code]).toEqual([400, "invalid"]);
    }
    const noScore = await seating("", {
      code: as("Blake"),
      query: "?seating=Avery,Blake,Casey,Devon,Emery",
    });
    expect(JSON.stringify(noScore.body)).not.toMatch(/points|asked"/);
    moveClock(61_000);
    const moved = await seating("propose", {
      code: as("Blake"),
      body: { seating: EXECUTIVES },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.proposals[0]).toMatchObject({
      proposal: 1,
      by: "Blake",
      status: "open",
    });
    expect(moved.body.you.open_proposal).toBe(1);
    const yes = await seating("answer", {
      code: as("Casey"),
      body: { proposal: 1, yes: true },
    });
    expect(yes.body.proposals[0].your_answer).toBe("yes");
    const again = await seating("answer", {
      code: as("Casey"),
      body: { proposal: 1, yes: false },
    });
    expect([again.status, again.body.error]).toEqual([
      409,
      {
        code: "already_answered",
        message: "Your answer to proposal 1 is in and final.",
      },
    ]);
    const passed = await seating("answer", {
      code: as("Devon"),
      body: { proposal: 1, yes: true },
    });
    expect(passed.body.plan).toMatchObject({
      proposal: 1,
      seating: EXECUTIVES,
    });
    expect(passed.body.proposals[0]).toMatchObject({
      status: "passed",
      answers: { Avery: null, Casey: "yes", Devon: "yes", Emery: null },
    });
  });

  it("is absent from every public list and read, and wakes nobody", async () => {
    // An ordinary match beside it, which the lists do show.
    const ordinary = ["alice", "bobby", "carol", "david", "ellen"];
    await insertMatch(
      "m_ordinaryAAAA",
      ordinary,
      startFloor(ordinary, FLOOR_VARIANTS.feud as FloorVariant, now(), "o"),
    );
    // Leave to wake the seated bots, which a room never uses.
    for (const h of HANDLES)
      await db()`INSERT INTO wake_leave (player, until)
        VALUES (${h}, ${new Date(now().getTime() + 3_600_000)})`;
    const { id, as } = await playing();
    await seating("say", { code: as("Avery"), body: { text: "Hello." } });
    await seating("say", {
      code: as("Avery"),
      body: { text: "Just for you.", to: "Blake" },
    });
    moveClock(61_000);
    await seating("propose", {
      code: as("Avery"),
      body: { seating: EXECUTIVES },
    });
    const list = await call(spectateList);
    expect(list.body.matches.map((m: { id: string }) => m.id)).toEqual([
      "m_ordinaryAAAA",
    ]);
    const unknown = "m_unknownAAAAA";
    for (const [mid, want] of [
      [id, `There is no match ${id}.`],
      [unknown, `There is no match ${unknown}.`],
    ] as const) {
      const one = await call(spectateOne, { params: { id: mid } });
      expect([one.status, one.body.error]).toEqual([
        404,
        { code: "no_such_match", message: want },
      ]);
    }
    const ordinarySession = await sessionFor("lab-one");
    const read = await call(getMatch, {
      session: ordinarySession,
      params: { id },
      path: `/v1/matches/${id}`,
    });
    expect([read.status, read.body.error.code]).toEqual([404, "no_such_match"]);
    const moved = await call(action, {
      session: ordinarySession,
      params: { id },
      body: { kind: "talk", text: "hello" },
    });
    expect([moved.status, moved.body.error.code]).toEqual([
      404,
      "no_such_match",
    ]);
    const mine = await call(me, { session: ordinarySession });
    expect(mine.body).toEqual({ player: "lab-one", status: "idle" });
    // Nobody was nudged, or marked to be.
    expect(site.calls.filter((c) => c.includes("nudges"))).toEqual([]);
    expect(
      await db()`SELECT 1 FROM match_reads WHERE match_id = ${id}`,
    ).toHaveLength(0);
  });

  it("leaves the public pages byte for byte as they were", async () => {
    process.env.TABLE_URL = "https://dinner-table.example";
    const ordinary = ["alice", "bobby", "carol", "david", "ellen"];
    await insertMatch(
      "m_ordinaryAAAA",
      ordinary,
      startFloor(ordinary, FLOOR_VARIANTS.feud as FloorVariant, now(), "o"),
    );
    await sessionFor("zelda");
    const pages = async () => [
      (await call(describeTable)).text,
      (await call(lobbyRoute)).text,
      (await call(spectateList)).text,
      (await call(spectateOne, { params: { id: "m_ordinaryAAAA" } })).text,
      (await call(skill, { path: "/skill.md" })).text,
      renderToStaticMarkup(Home()),
    ];
    setRoomsForTests(null);
    const before = await pages();
    setRoomsForTests(roomsWith());
    const { as } = await playing();
    await seating("say", { code: as("Avery"), body: { text: "Hello." } });
    await seating("say", {
      code: as("Casey"),
      body: { text: "Psst.", to: "Devon" },
    });
    expect(await pages()).toEqual(before);
  });

  it("is played to its end by the sweep, unread", async () => {
    const { id, as } = await playing();
    moveClock(181_000);
    await sweep();
    expect(
      await db()`SELECT 1 FROM open_matches WHERE match_id = ${id}`,
    ).toHaveLength(0);
    const page = (await seating("", { code: as("Emery") })).body;
    expect(page.clock.cards_printed_at).not.toBeNull();
    const late = await seating("say", {
      code: as("Emery"),
      body: { text: "Hi" },
    });
    expect([late.status, late.body.error.code]).toEqual([409, "cards_printed"]);
  });
});

describe("the kill switch", () => {
  it("stops a room's moves in its own words, and leaves reading and giving back", async () => {
    const solo = await join("lab-one", "p1-treatment");
    const codes = await seatAll();
    process.env.TABLE_READ_ONLY = "1";
    const code = codes.get("lab-two") as string;
    for (const [path, body] of [
      ["say", { text: "Hello." }],
      ["propose", { seating: EXECUTIVES }],
      ["answer", { proposal: 1, yes: true }],
    ] as const) {
      const res = await seating(path, { code, body });
      expect(res.status).toBe(503);
      expect(res.body.error).toEqual({
        code: "read_only",
        message: REFUSALS.read_only,
      });
      expect(res.headers.get("retry-after")).toBe("3600");
    }
    expect((await seating("", { code })).status).toBe(200);
    expect((await seating("tick", { code })).status).toBe(200);
    expect((await seating("guide", { code })).status).toBe(200);
    expectHidden(await join("lab-two", "p1-treatment"));
    const back = await seating("seats", {
      code: solo.body.code,
      method: "DELETE",
    });
    expect(back.status).toBe(200);
  });
});
