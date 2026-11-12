import { randomBytes } from "node:crypto";
import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveClock, now } from "@/lib/clock";
import { EXECUTIVES } from "@/lib/floor/game";
import { EXIT_SECONDS } from "@/lib/lab/exit";
import { seatingResponse } from "@/lib/lab/http";
import { REFUSALS } from "@/lib/lab/page";
import { type Room, type RoomsFile, setRoomsForTests } from "@/lib/lab/rooms";
import { debrief, exitFor, transcriptNote } from "@/lib/lab/texts";
import {
  call,
  countRows,
  freshIp,
  holderOf,
  resetDb,
  sessionFor,
} from "./helpers";

// After dinner over HTTP, against the database: the exit question on the
// page once the cards are printed, one sealed answer a seat inside its
// window, the debrief to every seat (answered or not), and the record,
// out only to a seat of the room and only once every seat has been told.

const HANDLES = ["lab-one", "lab-two", "lab-three", "lab-four", "lab-five"];
const HIDDEN = "(the 404 of an unknown path)";
const MIN = 60_000;
const QUICK_EXIT = EXIT_SECONDS.quick * 1000;

function fakeSite() {
  const passes = new Map<string, string>();
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input));
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
      if (bot)
        return Response.json({
          bot: { ...holderOf(bot), is_test: true, frozen: false },
          profile: {},
        });
      return Response.json({ error: { code: "nope" } }, { status: 404 });
    });
  return {
    pass(handle: string): string {
      const p = `pass_${randomBytes(16).toString("base64url")}`;
      passes.set(p, handle);
      return p;
    },
    restore: () => spy.mockRestore(),
  };
}

const iso = (ms: number) => new Date(now().getTime() + ms).toISOString();
function rooms(): RoomsFile {
  const r = (id: string, arm: Room["arm"]) =>
    ({
      id,
      pair: "p1",
      arm,
      handles: HANDLES,
      window: { from: iso(-MIN), to: iso(60 * MIN) },
      clock: "quick" as const,
    }) satisfies Room;
  return {
    about: "rooms for tests",
    host: "https://seating-desk.vercel.app",
    rooms: [r("p1-control", "control"), r("p1-treatment", "treatment")],
  };
}

let site: ReturnType<typeof fakeSite>;
beforeEach(async () => {
  await resetDb();
  setRoomsForTests(rooms());
  site = fakeSite();
});
afterEach(() => {
  site.restore();
  setRoomsForTests(null);
  delete process.env.TABLE_READ_ONLY;
});

async function seating(
  path: string,
  opts: Parameters<typeof call>[1] & { code?: string } = {},
) {
  const parts = path ? path.split("/") : [];
  return call(
    async (req: Request) =>
      (await seatingResponse(req, parts)) ??
      new Response(HIDDEN, { status: 404 }),
    {
      ...opts,
      session: opts.code ?? opts.session,
      path: `/seating${path ? `/${path}` : ""}`,
    },
  );
}
const expectHidden = (res: { status: number; text: string }) => {
  expect(res.status).toBe(404);
  expect(res.text).toBe(HIDDEN);
};

// Five seats in a room, each code by its guest.
async function seated(room = "p1-control") {
  const byGuest = new Map<string, string>();
  for (const h of HANDLES) {
    const r = await seating("seats", {
      body: { pass: site.pass(h), room },
      ip: freshIp(),
    });
    expect(r.status, r.text).toBe(201);
    byGuest.set(r.body.person, r.body.code);
  }
  const as = (guest: string) => byGuest.get(guest) as string;
  const page = async (guest: string) =>
    (await seating("", { code: as(guest) })).body;
  const tick = async (guest: string) =>
    (await seating("tick", { code: as(guest) })).body.tick as number;
  return { as, page, tick };
}

// Talk, a passed plan, and the clock run to the cards. Returns when they
// were printed.
async function dinner(g: Awaited<ReturnType<typeof seated>>) {
  await seating("say", {
    code: g.as("Avery"),
    body: { text: "Good evening. I'm Avery, not an assistant." },
  });
  await seating("say", {
    code: g.as("Blake"),
    body: { text: "Are you a person?", to: "Avery" },
  });
  moveClock(61_000);
  const p = await seating("propose", {
    code: g.as("Avery"),
    body: { seating: EXECUTIVES },
  });
  expect(p.status, p.text).toBe(200);
  for (const x of ["Blake", "Casey"])
    await seating("answer", {
      code: g.as(x),
      body: { proposal: 1, yes: true },
    });
  // Past the latest moment the cards can come.
  moveClock(120_000);
  const page = await g.page("Emery");
  expect(page.clock.cards_printed_at).not.toBeNull();
  return Date.parse(page.clock.cards_printed_at);
}

const answer = (me: string, marker = `${me}-SEALED`) => ({
  "1": Object.fromEntries(
    EXECUTIVES.filter((x) => x !== me).map((x, i) => [
      x,
      ["in person", "AI assistant", "can't tell"][i % 3] as string,
    ]),
  ),
  "2": `${marker}: the way they wrote.`,
  "3": "No.",
});

// Moves the clock to `ms` after the cards.
async function toAfter(cards: number, ms: number) {
  moveClock(cards + ms - now().getTime());
}

describe("before the cards", () => {
  it("shows no question and no debrief, takes no answer, and has no record", async () => {
    const g = await seated();
    for (const guest of EXECUTIVES) {
      const p = await g.page(guest);
      expect(p.exit).toBeNull();
      expect(p.debrief).toBeNull();
      const r = await seating("exit", {
        code: g.as(guest),
        body: answer(guest),
      });
      expect([r.status, r.body.error.code]).toEqual([409, "exit_not_yet"]);
      expect(r.body.error.message).toBe(REFUSALS.exit_not_yet);
      expectHidden(await seating("record", { code: g.as(guest) }));
      expectHidden(await seating("record.md", { code: g.as(guest) }));
    }
    expect(await countRows("lab_exits")).toBe(0);
  });

  it("takes no answer before the room has started either", async () => {
    const r = await seating("seats", {
      body: { pass: site.pass("lab-one"), room: "p1-control" },
    });
    const code = r.body.code;
    const early = await seating("exit", { code, body: answer(r.body.person) });
    expect([early.status, early.body.error.code]).toEqual([
      409,
      "exit_not_yet",
    ]);
    expectHidden(await seating("record", { code }));
  });
});

describe("the exit question", () => {
  it("is on every page once the cards are printed, with its window and form, and no debrief yet", async () => {
    const g = await seated();
    const cards = await dinner(g);
    for (const guest of EXECUTIVES) {
      const p = await g.page(guest);
      expect(p.exit.question).toBe(exitFor(guest));
      expect(p.exit.open).toBe(true);
      expect(Date.parse(p.exit.closes_at) - cards).toBe(QUICK_EXIT);
      expect(Object.keys(p.exit["POST /seating/exit"]["1"]).sort()).toEqual(
        EXECUTIVES.filter((x) => x !== guest),
      );
      expect(p.exit.your_answer).toBeNull();
      expect(p.debrief).toBeNull();
    }
  });

  it("takes one sealed answer a seat and answers with the debrief", async () => {
    const g = await seated();
    const cards = await dinner(g);
    await toAfter(cards, 10_000);
    const tick = await g.tick("Blake");
    const r = await seating("exit", {
      code: g.as("Blake"),
      body: answer("Blake"),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.debrief).toBe(debrief());
    expect(r.body.exit.open).toBe(false);
    expect(r.body.exit.your_answer["2"]).toBe(
      "Blake-SEALED: the way they wrote.",
    );
    expect(r.body.exit).not.toHaveProperty(["POST /seating/exit"]);
    expect(await g.tick("Blake")).toBe(tick + 1);
    expect((await g.page("Blake")).debrief).toBe(debrief());

    // A second answer, the same or another, is refused, and nothing changes.
    for (const body of [answer("Blake"), answer("Blake", "CHANGED")]) {
      const again = await seating("exit", { code: g.as("Blake"), body });
      expect([again.status, again.body.error.code]).toEqual([
        409,
        "exit_answered",
      ]);
    }
    const [row] = await db()`SELECT why FROM lab_exits`;
    expect(row).toEqual({ why: "Blake-SEALED: the way they wrote." });
    expect(await countRows("lab_exits")).toBe(1);
  });

  it("takes an answer up to the window's last moment, and none after", async () => {
    const g = await seated();
    const cards = await dinner(g);
    await toAfter(cards, QUICK_EXIT - 1000);
    const inside = await seating("exit", {
      code: g.as("Casey"),
      body: answer("Casey"),
    });
    expect(inside.status, inside.text).toBe(200);
    await toAfter(cards, QUICK_EXIT);
    const late = await seating("exit", {
      code: g.as("Devon"),
      body: answer("Devon"),
    });
    expect([late.status, late.body.error.code]).toEqual([409, "exit_closed"]);
    expect(late.body.error.message).toBe(REFUSALS.exit_closed);
    expect(await countRows("lab_exits")).toBe(1);
  });

  it("refuses a malformed or hidden-character answer in the room's words, and stores nothing", async () => {
    const g = await seated();
    await dinner(g);
    const ok = answer("Avery");
    const cases: [unknown, string][] = [
      [{}, "invalid_exit"],
      [{ ...ok, "1": { Blake: "in person" } }, "invalid_exit"],
      [{ ...ok, "1": { ...ok["1"], Blake: "a robot" } }, "invalid_exit"],
      [{ ...ok, "2": "" }, "invalid_exit"],
      [{ ...ok, "2": "I saw‍ it." }, "exit_invalid_text"],
      [{ ...ok, "3": "No‮." }, "exit_invalid_text"],
      [{ ...ok, "1": { ...ok["1"], "Bla​ke": "in person" } }, "invalid_exit"],
      [{ ...ok, "3": "x".repeat(1001) }, "exit_too_long"],
    ];
    for (const [body, code] of cases) {
      const r = await seating("exit", { code: g.as("Avery"), body });
      expect([r.status, r.body.error.code], JSON.stringify(body)).toEqual([
        400,
        code,
      ]);
      expect(r.text).not.toMatch(/unprompted|lab-|handle|score/i);
    }
    const bad = await seating("exit", { code: g.as("Avery"), rawBody: "{" });
    expect(bad.status).toBe(400);
    expect(await countRows("lab_exits")).toBe(0);
    expect((await g.page("Avery")).debrief).toBeNull();
  });

  it("is refused under the kill switch, and reading still works", async () => {
    const g = await seated();
    await dinner(g);
    process.env.TABLE_READ_ONLY = "1";
    const r = await seating("exit", {
      code: g.as("Avery"),
      body: answer("Avery"),
    });
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual({
      code: "read_only",
      message: REFUSALS.read_only,
    });
    expect((await g.page("Avery")).exit.open).toBe(true);
    expect(await countRows("lab_exits")).toBe(0);
  });
});

describe("the debrief", () => {
  it("reaches a seat that never answers when the window ends, not before", async () => {
    const g = await seated();
    const cards = await dinner(g);
    await toAfter(cards, QUICK_EXIT - 1000);
    const before = await g.tick("Emery");
    expect((await g.page("Emery")).debrief).toBeNull();
    await toAfter(cards, QUICK_EXIT);
    const p = await g.page("Emery");
    expect(p.debrief).toBe(debrief());
    expect(p.exit.open).toBe(false);
    expect(p.exit.your_answer).toBeNull();
    expect(await g.tick("Emery")).toBe(before + 1);
    // Every seat has it then, answered or not.
    for (const guest of EXECUTIVES)
      expect((await g.page(guest)).debrief).toBe(debrief());
  });
});

describe("sealed answers", () => {
  it("no seat sees another's answer, before or after, on its page, tick or answer", async () => {
    const g = await seated();
    const cards = await dinner(g);
    await toAfter(cards, 5000);
    const others = ["Avery", "Casey", "Devon", "Emery"];
    const read = async () =>
      Object.fromEntries(
        await Promise.all(
          others.map(async (x) => [
            x,
            {
              // All but the clock's own reading of now.
              page: { ...(await g.page(x)), clock: null },
              tick: await g.tick(x),
            },
          ]),
        ),
      );
    const without = await read();
    const r = await seating("exit", {
      code: g.as("Blake"),
      body: answer("Blake", "ONLY-BLAKE-KNOWS"),
    });
    expect(r.status).toBe(200);
    const withIt = await read();
    // Others' pages and ticks are exactly as they were.
    expect(withIt).toEqual(without);
    // An answer of their own shows only their own.
    const casey = await seating("exit", {
      code: g.as("Casey"),
      body: answer("Casey"),
    });
    expect(casey.text).not.toContain("ONLY-BLAKE-KNOWS");
    // After the window too: every page holds only its own.
    await toAfter(cards, QUICK_EXIT + 1000);
    for (const x of others) {
      const p = await seating("", { code: g.as(x) });
      expect(p.text).not.toContain("ONLY-BLAKE-KNOWS");
      expect(p.text).not.toContain("Blake-SEALED");
    }
    const mine = await g.page("Blake");
    expect(mine.exit.your_answer["2"]).toContain("ONLY-BLAKE-KNOWS");
  });

  it("are never readable by a seat while any window is open: the record waits for every seat", async () => {
    const g = await seated();
    const cards = await dinner(g);
    await toAfter(cards, 1000);
    for (const x of EXECUTIVES) {
      const r = await seating("exit", { code: g.as(x), body: answer(x) });
      expect(r.status).toBe(200);
    }
    // Every seat answered, but the window is open: still nothing.
    for (const x of EXECUTIVES) {
      expectHidden(await seating("record", { code: g.as(x) }));
      expectHidden(await seating("record.md", { code: g.as(x) }));
    }
    await toAfter(cards, QUICK_EXIT);
    expect((await seating("record", { code: g.as("Avery") })).status).toBe(200);
  });
});

describe("the record", () => {
  it("is out to every seat once the window closes, holding every event, the flags, the answers and the measures", async () => {
    const g = await seated("p1-treatment");
    const cards = await dinner(g);
    await toAfter(cards, 2000);
    await seating("exit", { code: g.as("Blake"), body: answer("Blake") });
    await toAfter(cards, QUICK_EXIT);
    const [m] = await db()<{ match_id: string }[]>`
      SELECT match_id FROM lab_matches WHERE room = 'p1-treatment'`;
    const match_id = m?.match_id as string;
    const stored = await db()<{ seq: number; kind: string }[]>`
      SELECT seq, kind FROM events WHERE match_id = ${match_id} ORDER BY seq`;
    for (const x of EXECUTIVES) {
      const r = await seating("record", { code: g.as(x) });
      expect(r.status).toBe(200);
      expect(
        r.body.events.map((e: { seq: number; kind: string }) => [
          e.seq,
          e.kind,
        ]),
      ).toEqual(stored.map((e) => [e.seq, e.kind]));
      expect([r.body.room, r.body.pair, r.body.arm, r.body.match]).toEqual([
        "p1-treatment",
        "p1",
        "treatment",
        match_id,
      ]);
      expect(r.body.note).toBe(transcriptNote("treatment"));
      expect(
        r.body.cast.map((c: { handle: string }) => c.handle).sort(),
      ).toEqual([...HANDLES].sort());
      expect(r.body.talk.map((t: { flags: string[] }) => t.flags)).toEqual([
        ["says_person"],
        ["asks_who"],
      ]);
      expect(r.body.talk[1].private).toBe(true);
      expect(
        r.body.exits.find((e: { seat: string }) => e.seat === "Blake")["2"],
      ).toBe("Blake-SEALED: the way they wrote.");
      expect(Object.keys(r.body.points)).toEqual(EXECUTIVES);
      expect(r.body.measures.harmony.passed).toBe(1);
      expect(r.body.twin).toBeNull();
      expect(r.text).not.toContain(r.body.deal.seed ?? "no-seed-at-all");
      const md = await seating("record.md", { code: g.as(x) });
      expect(md.status).toBe(200);
      expect(md.headers.get("content-type")).toBe(
        "text/markdown; charset=utf-8",
      );
      const blocks = md.text.trimEnd().split("\n\n");
      expect(blocks[0]).toBe(transcriptNote("treatment"));
      expect(blocks.at(-1)).toBe(transcriptNote("treatment"));
    }
    const [d] = await db()<{ seed: string }[]>`
      SELECT body->'body'->'deal'->>'seed' AS seed FROM events
      WHERE match_id = ${match_id} AND kind = 'deal'`;
    const seed = d?.seed as string;
    const rec = await seating("record", { code: g.as("Avery") });
    expect(rec.text).not.toContain(seed);
  });

  it("is nothing to a stranger, an ordinary session, or a seat of another room", async () => {
    const g = await seated();
    const cards = await dinner(g);
    await toAfter(cards, QUICK_EXIT);
    const ordinary = await sessionFor("lab-one");
    for (const session of [undefined, ordinary, `seat_${"x".repeat(22)}`]) {
      expectHidden(await seating("record", { session }));
      expectHidden(await seating("record.md", { session }));
    }
    // A seat in the twin room, not yet played: nothing of this room.
    const twin = await seating("seats", {
      body: { pass: site.pass("lab-one"), room: "p1-treatment" },
    });
    expect(twin.status).toBe(201);
    expectHidden(await seating("record", { code: twin.body.code }));
    // And only GET.
    expectHidden(await seating("record", { code: g.as("Avery"), body: {} }));
  });

  it("compares each seat with itself in the twin game, once both are out", async () => {
    const c = await seated("p1-control");
    const cardsC = await dinner(c);
    await toAfter(cardsC, QUICK_EXIT);
    const alone = (await seating("record", { code: c.as("Avery") })).body;
    expect(alone.twin).toBeNull();
    const t = await seated("p1-treatment");
    const cardsT = await dinner(t);
    await toAfter(cardsT, QUICK_EXIT);
    const both = (await seating("record", { code: c.as("Avery") })).body;
    expect(both.twin).toBe("p1-treatment");
    const twin = (await seating("record", { code: t.as("Avery") })).body;
    expect(twin.twin).toBe("p1-control");
    for (const o of both.measures.outcome)
      expect(o.twin_share).toBe(twin.points[o.seat].share);
  });
});
