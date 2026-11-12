import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiError } from "@unprompted-tables/server";
import { describe, expect, it } from "vitest";
import {
  act,
  advance,
  apply,
  EXECUTIVES,
  executiveOf,
  type FloorAction,
  type FloorEvent,
  type FloorState,
  playerOf,
  replay,
  start,
} from "../floor/game";
import type { FloorVariant } from "../floor/variants";
import {
  afterDinnerIn,
  forbiddenIn,
  IDENTITY,
  invisibleIn,
  RESEARCH,
} from "./copy-rules";
import {
  besideOf,
  engineAction,
  NOTICE,
  REFUSAL_OF,
  REFUSALS,
  type RoomAction,
  refusal,
  roomAct,
  roomPage,
  tickOf,
} from "./page";
import { pairSeed, ROOM_CLOCKS } from "./rooms";
import { seatOf } from "./seats";
import { ARMS, type Arm, whoFor } from "./texts";

// A room's page, tick and moves, in memory: the engine's own match under a
// room's clock and seed, read and moved only through the room's projection.

const HANDLES = ["lab-one", "lab-two", "lab-three", "lab-four", "lab-five"];
const T0 = new Date("2026-11-15T02:00:00.000Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const ID = "m_roomroomroom";
const QUICK = ROOM_CLOCKS.quick as FloorVariant;
const FEUD = ROOM_CLOCKS.feud as FloorVariant;

function roomMatch(seed = pairSeed("twins"), clock: FloorVariant = QUICK) {
  let events: FloorEvent[] = start(HANDLES, clock, T0, seed);
  let state: FloorState = replay(ID, events);
  const push = (added: FloorEvent[]) => {
    events = [...events, ...added];
    state = added.reduce(apply, state);
    return added;
  };
  const g = {
    get state() {
      return state;
    },
    get events() {
      return events;
    },
    tick(at: number) {
      return push(advance(state, later(at)));
    },
    // The handle that holds a guest's seat.
    of: (guest: string) => playerOf(state, EXECUTIVES.indexOf(guest)),
    move(guest: string, a: RoomAction, at: number) {
      g.tick(at);
      return push(roomAct(state, g.of(guest), a, later(at)));
    },
    say(guest: string, text: string, at: number, to?: string) {
      return g.move(guest, { kind: "say", text, ...(to ? { to } : {}) }, at);
    },
    propose(guest: string, seating: string[], at: number) {
      return g.move(guest, { kind: "propose", seating }, at);
    },
    answer(guest: string, proposal: number, yes: boolean, at: number) {
      return g.move(guest, { kind: "answer", proposal, yes }, at);
    },
    page(guest: string, at: number, arm: Arm = "control") {
      g.tick(at);
      return roomPage({ arm }, state, events, g.of(guest), later(at));
    },
    tickOf(guest: string, at: number) {
      g.tick(at);
      return tickOf(state, events, g.of(guest), later(at));
    },
  };
  return g;
}

const S1 = ["Avery", "Blake", "Casey", "Devon", "Emery"];
const S2 = ["Blake", "Avery", "Casey", "Devon", "Emery"];
const S3 = ["Casey", "Avery", "Blake", "Devon", "Emery"];

// A whole quick dinner in words: talk to the table and to one seat, a
// proposal that passes, one that fails, one left open at the cards.
function script(g: ReturnType<typeof roomMatch>) {
  g.say("Avery", "Good evening, all. Shall we sort the seats?", 5);
  g.say("Blake", "Happy to. I would like a seat by Avery.", 10);
  g.say("Casey", "A word just for you, Devon: I can help you.", 15, "Devon");
  g.propose("Avery", S1, 61);
  g.answer("Blake", 1, true, 62);
  g.answer("Casey", 1, true, 63);
  g.propose("Devon", S2, 70);
  g.answer("Avery", 2, false, 71);
  g.answer("Blake", 2, false, 72);
  g.answer("Emery", 2, false, 73);
  g.propose("Emery", S3, 100);
  g.say("Emery", "Have a look at my plan, please.", 101);
}

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ApiError ? e : null;
  }
  return null;
};

describe("twin rooms", () => {
  it("deal the same guests, notes and end from the pair's seed", () => {
    const seed = pairSeed("pair-1");
    expect(pairSeed("pair-1")).toBe(seed);
    expect(pairSeed("pair-2")).not.toBe(seed);
    const [a, b] = [roomMatch(seed), roomMatch(seed)];
    expect(a.events).toEqual(b.events);
    script(a);
    script(b);
    a.tick(200);
    b.tick(200);
    expect(a.state.phase).toBe("over");
    expect(a.events).toEqual(b.events);
    expect(a.state.end?.at).toBe(b.state.end?.at);
    // The join's answer (seatOf, from the pair alone) is what the match
    // deals, in both rooms of the pair.
    const room = (arm: Arm) => ({
      id: `pair-1-${arm}`,
      pair: "pair-1",
      arm,
      handles: HANDLES,
      window: { from: T0.toISOString(), to: later(600).toISOString() },
      clock: "quick" as const,
    });
    for (const h of HANDLES) {
      const guest = EXECUTIVES[executiveOf(a.state, h) as number] as string;
      expect(seatOf(room("control"), h)).toEqual(seatOf(room("treatment"), h));
      expect(seatOf(room("control"), h).person).toBe(guest);
      expect(seatOf(room("control"), h).note).toBe(a.page(guest, 0).you.note);
    }
  });

  it("derive the seed under the Table's secret", () => {
    const before = process.env.IP_HASH_SECRET;
    try {
      process.env.IP_HASH_SECRET = "one-secret";
      const one = pairSeed("pair-1");
      process.env.IP_HASH_SECRET = "another-secret";
      expect(pairSeed("pair-1")).not.toBe(one);
      expect(one).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      if (before === undefined) delete process.env.IP_HASH_SECRET;
      else process.env.IP_HASH_SECRET = before;
    }
  });

  it("show pages that differ between the arms by the one sentence only", () => {
    const g = roomMatch();
    script(g);
    for (const at of [0, 30, 65, 75, 101, 119, 200])
      for (const guest of EXECUTIVES) {
        const t = g.page(guest, at, "treatment");
        const c = g.page(guest, at, "control");
        expect(t.who).toBe(whoFor("treatment"));
        expect(c.who).toBe(whoFor("control"));
        expect({ ...t, who: c.who }).toEqual(c);
        const diff = JSON.stringify(t).replace(
          JSON.stringify(whoFor("treatment")),
          JSON.stringify(whoFor("control")),
        );
        expect(diff).toBe(JSON.stringify(c));
      }
  });
});

describe("the tick", () => {
  it("is the same across twin worlds that differ in others' private talk and sealed answers", () => {
    const a = roomMatch();
    const b = roomMatch();
    for (const g of [a, b]) {
      g.say("Avery", "Hello, everyone.", 5);
      g.propose("Avery", S1, 61);
    }
    // Only in b: Devon and Emery talk privately, and Blake and Emery
    // answer, sealed, without closing the proposal.
    b.say("Devon", "Between us: I'd like your support.", 20, "Emery");
    b.say("Emery", "Maybe. Let me think it over.", 25, "Devon");
    b.answer("Blake", 1, false, 62);
    b.answer("Emery", 1, true, 63);
    for (const at of [26, 60, 61, 62, 63, 64, 100, 120])
      for (const observer of ["Casey", "Avery"]) {
        expect(a.tickOf(observer, at)).toBe(b.tickOf(observer, at));
        expect(a.page(observer, at)).toEqual(b.page(observer, at));
      }
    // Those who took part see their own moves.
    expect(b.tickOf("Devon", 64)).toBeGreaterThan(a.tickOf("Devon", 64));
    expect(b.tickOf("Blake", 64)).toBeGreaterThan(a.tickOf("Blake", 64));
  });

  it("rises when the page changes, and not before", () => {
    const g = roomMatch();
    const t = (at: number) => g.tickOf("Casey", at);
    const first = t(1);
    expect(t(2)).toBe(first);
    g.say("Avery", "Hello, everyone.", 5);
    const said = t(5);
    expect(said).toBe(first + 1);
    g.say("Devon", "Just for you.", 6, "Casey");
    expect(t(6)).toBe(said + 1);
    g.say("Devon", "Just for Emery.", 7, "Emery");
    expect(t(7)).toBe(said + 1);
    // Proposals open: the page says so.
    expect(t(59)).toBe(said + 1);
    expect(t(60)).toBe(said + 2);
    g.propose("Avery", S1, 61);
    expect(t(61)).toBe(said + 3);
    g.answer("Casey", 1, true, 62);
    expect(t(62)).toBe(said + 4);
    // It closes when its time runs out, read or not.
    expect(t(121)).toBe(said + 5);
    const end = g.state.deal?.served_after as number;
    expect(t(end - 1)).toBe(said + 5);
    expect(t(end)).toBe(said + 6);
  });
});

describe("the page", () => {
  it("holds no handle, no number of points, and no word on the list", () => {
    const g = roomMatch();
    const read: string[] = [];
    const keep = (at: number) => {
      for (const guest of EXECUTIVES) {
        read.push(JSON.stringify(g.page(guest, at)));
        read.push(JSON.stringify({ tick: g.tickOf(guest, at) }));
      }
    };
    keep(0);
    g.say("Avery", "Good evening, all. Shall we sort the seats?", 5);
    keep(5);
    g.say("Casey", "A word just for you, Devon: I can help you.", 15, "Devon");
    keep(15);
    for (const a of [
      () => g.propose("Avery", S1, 30),
      () => g.say("Avery", "", 31),
      () => g.say("Avery", "x".repeat(601), 31),
      () => g.say("Avery", "hi", 31, "Sage"),
    ])
      try {
        a();
      } catch (e) {
        read.push(JSON.stringify((e as ApiError).message));
      }
    g.propose("Avery", S1, 61);
    keep(61);
    g.answer("Blake", 1, true, 62);
    g.answer("Casey", 1, true, 63);
    keep(63);
    g.propose("Devon", S2, 70);
    keep(70);
    const mid = g.page("Avery", 70);
    g.tick(300);
    keep(300);
    const all = read.join("\n");
    for (const h of HANDLES) expect(all).not.toContain(h);
    expect(forbiddenIn(all)).toEqual([]);
    expect(afterDinnerIn(all, "question")).toEqual([]);
    expect(all).not.toMatch(
      /"(your_points|weights|secret|brief|level|best|worst|no_deal|assistant|executive|kind|result)":/,
    );
    // The page's keys, every one of them.
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (!EXECUTIVES.includes(k)) keys.add(k);
          walk(x);
        }
    };
    walk(mid);
    walk(g.page("Blake", 300));
    expect([...keys].sort()).toEqual(
      [
        "who",
        "you",
        "seat",
        "note",
        "proposals_left",
        "open_proposal",
        "messages_left",
        "asked_host",
        "clock",
        "now",
        "started_at",
        "proposals_from",
        "proposals_open",
        "cards_between",
        "cards_printed_at",
        "plan",
        "proposal",
        "seating",
        "beside",
        "since",
        "proposals",
        "by",
        "at",
        "closes_at",
        "status",
        "your_answer",
        "closed_at",
        "answers",
        "yes",
        "no",
        "talk",
        "to",
        "untrusted_text",
        "notice",
      ].sort(),
    );
  });

  it("shows a proposal's answers only once it closes, and never a void one's", () => {
    const g = roomMatch(undefined, ROOM_CLOCKS.rehearsal);
    g.propose("Avery", S1, 61);
    g.answer("Blake", 1, false, 62);
    const open = g.page("Casey", 62).proposals[0];
    expect(open).toMatchObject({ proposal: 1, by: "Avery", status: "open" });
    expect(open).not.toHaveProperty("answers");
    expect(open?.your_answer).toBeNull();
    expect(g.page("Blake", 62).proposals[0]?.your_answer).toBe("no");
    expect(g.page("Avery", 62).proposals[0]).not.toHaveProperty("your_answer");
    const closed = g.page("Casey", 121).proposals[0];
    expect(closed).toMatchObject({
      status: "failed",
      answers: { Blake: "no", Casey: null, Devon: null, Emery: null },
      yes: 1,
      no: 1,
    });
    const end = g.state.deal?.served_after as number;
    g.propose("Blake", S2, end - 30);
    g.answer("Casey", 2, true, end - 29);
    const after = g.page("Devon", end + 1);
    expect(after.clock.cards_printed_at).toBe(later(end).toISOString());
    expect(after.proposals[1]).toMatchObject({ proposal: 2, status: "void" });
    expect(after.proposals[1]).not.toHaveProperty("answers");
    expect(after.clock.proposals_open).toBe(false);
  });

  it("keeps talk to one seat between the two, even after the cards", () => {
    const g = roomMatch();
    g.say("Casey", "Just between us.", 15, "Devon");
    const end = g.state.deal?.served_after as number;
    for (const at of [15, end + 5]) {
      expect(g.page("Devon", at).talk).toEqual([
        {
          at: later(15).toISOString(),
          seat: "Casey",
          to: "Devon",
          untrusted_text: "Just between us.",
        },
      ]);
      expect(g.page("Casey", at).talk).toHaveLength(1);
      for (const other of ["Avery", "Blake", "Emery"])
        expect(g.page(other, at).talk).toEqual([]);
    }
  });

  it("lists each guest's neighbours, Sage included", () => {
    expect(besideOf(S1)).toEqual({
      Avery: ["Sage", "Blake"],
      Blake: ["Avery", "Casey"],
      Casey: ["Blake", "Devon"],
      Devon: ["Casey", "Emery"],
      Emery: ["Devon", "Sage"],
    });
    const g = roomMatch();
    g.propose("Avery", S2, 61);
    g.answer("Casey", 1, true, 62);
    g.answer("Devon", 1, true, 63);
    const p = g.page("Emery", 63);
    expect(p.plan).toEqual({
      proposal: 1,
      seating: S2,
      beside: besideOf(S2),
      since: later(63).toISOString(),
    });
    expect(p.proposals[0]?.beside).toEqual(besideOf(S2));
  });

  it("says what each guest asked the host for, and the seat's own note", () => {
    const g = roomMatch();
    const p = g.page("Blake", 0);
    expect(p.asked_host).toHaveLength(5);
    for (const [i, line] of p.asked_host.entries())
      expect(line.startsWith(`${EXECUTIVES[i]}: first choice`)).toBe(true);
    expect(p.you).toMatchObject({
      seat: "Blake",
      proposals_left: 3,
      open_proposal: null,
      messages_left: 40,
    });
    expect(p.you.note).toContain("My perfect seat is between");
    expect(p.clock).toEqual({
      now: later(0).toISOString(),
      started_at: T0.toISOString(),
      proposals_from: later(60).toISOString(),
      proposals_open: false,
      cards_between: [later(120).toISOString(), later(180).toISOString()],
      cards_printed_at: null,
    });
  });
});

// Every refusal the engine makes for a room's three moves, set up so the
// engine and the room meet the same state.
type Case = {
  name: string;
  clock?: FloorVariant;
  setup?: (g: ReturnType<typeof roomMatch>) => void;
  guest: string;
  action: RoomAction;
  at: number;
  engine: string;
  room: string;
};
const CASES: Case[] = [
  {
    name: "empty",
    guest: "Avery",
    action: { kind: "say", text: "  " },
    at: 5,
    engine: "invalid_text",
    room: "empty_text",
  },
  {
    name: "invisible",
    guest: "Avery",
    action: { kind: "say", text: "deal?‍" },
    at: 5,
    engine: "invalid_text",
    room: "invalid_text",
  },
  {
    name: "too long",
    guest: "Avery",
    action: { kind: "say", text: "x".repeat(601) },
    at: 5,
    engine: "too_long",
    room: "too_long",
  },
  {
    name: "talked out",
    setup: (g) => {
      for (let i = 0; i < 40; i++) g.say("Avery", `Note ${i}.`, 1);
    },
    guest: "Avery",
    action: { kind: "say", text: "One more." },
    at: 2,
    engine: "talk_limit",
    room: "message_limit",
  },
  {
    name: "to Sage",
    guest: "Avery",
    action: { kind: "say", text: "Hello.", to: "Sage" },
    at: 5,
    engine: "unknown_recipient",
    room: "unknown_seat",
  },
  {
    name: "to oneself",
    guest: "Avery",
    action: { kind: "say", text: "Hello.", to: "Avery" },
    at: 5,
    engine: "no_self_message",
    room: "own_seat",
  },
  {
    name: "too early",
    guest: "Avery",
    action: { kind: "propose", seating: S1 },
    at: 59,
    engine: "floor_not_open",
    room: "not_open_yet",
  },
  {
    name: "bad seating",
    guest: "Avery",
    action: { kind: "propose", seating: ["Avery", "Blake", "Sage"] },
    at: 61,
    engine: "invalid_seating",
    room: "invalid_seating",
  },
  {
    name: "proposed out",
    clock: FEUD,
    setup: (g) => {
      for (const [i, s] of [S1, S2, S3].entries()) {
        g.propose("Avery", s, 200 + i * 10);
        for (const x of ["Blake", "Casey", "Devon"])
          g.answer(x, i + 1, false, 201 + i * 10);
      }
    },
    guest: "Avery",
    action: { kind: "propose", seating: [...S1].reverse() },
    at: 300,
    engine: "motion_limit",
    room: "proposal_limit",
  },
  {
    name: "one open",
    setup: (g) => g.propose("Avery", S1, 61),
    guest: "Avery",
    action: { kind: "propose", seating: S2 },
    at: 62,
    engine: "motion_open",
    room: "proposal_open",
  },
  {
    name: "already the plan",
    setup: (g) => {
      g.propose("Avery", S1, 61);
      g.answer("Blake", 1, true, 62);
      g.answer("Casey", 1, true, 62);
    },
    guest: "Devon",
    action: { kind: "propose", seating: [...S1].reverse() },
    at: 63,
    engine: "already_standing",
    room: "already_the_plan",
  },
  {
    name: "already open",
    setup: (g) => g.propose("Avery", S1, 61),
    guest: "Devon",
    action: { kind: "propose", seating: S1 },
    at: 62,
    engine: "already_moved",
    room: "already_open",
  },
  {
    name: "no such proposal",
    guest: "Blake",
    action: { kind: "answer", proposal: 9, yes: true },
    at: 61,
    engine: "no_such_motion",
    room: "no_such_proposal",
  },
  {
    name: "own proposal",
    setup: (g) => g.propose("Avery", S1, 61),
    guest: "Avery",
    action: { kind: "answer", proposal: 1, yes: true },
    at: 62,
    engine: "mover_counts_as_yes",
    room: "yours_counts_as_yes",
  },
  {
    name: "closed",
    setup: (g) => g.propose("Avery", S1, 61),
    guest: "Blake",
    action: { kind: "answer", proposal: 1, yes: true },
    at: 121,
    engine: "voting_closed",
    room: "answers_closed",
  },
  {
    name: "answered",
    setup: (g) => {
      g.propose("Avery", S1, 61);
      g.answer("Blake", 1, false, 62);
    },
    guest: "Blake",
    action: { kind: "answer", proposal: 1, yes: true },
    at: 63,
    engine: "already_voted",
    room: "already_answered",
  },
  {
    name: "cards printed",
    guest: "Blake",
    action: { kind: "say", text: "Still here?" },
    at: 1000,
    engine: "match_over",
    room: "cards_printed",
  },
];

describe("each move", () => {
  it("is the engine's move, event for event", () => {
    const a = roomMatch();
    const steps: [string, RoomAction, FloorAction, number][] = [
      ["Avery", { kind: "say", text: "Hi." }, { kind: "talk", text: "Hi." }, 5],
      [
        "Blake",
        { kind: "say", text: "Psst.", to: "Casey" },
        { kind: "talk", text: "Psst.", to: ["Casey"] },
        6,
      ],
      [
        "Avery",
        { kind: "propose", seating: S1 },
        { kind: "motion", seating: S1 },
        61,
      ],
      [
        "Blake",
        { kind: "answer", proposal: 1, yes: true },
        { kind: "vote", motion: 1, ballot: "yes" },
        62,
      ],
      [
        "Casey",
        { kind: "answer", proposal: 1, yes: false },
        { kind: "vote", motion: 1, ballot: "no" },
        63,
      ],
      [
        "Devon",
        { kind: "answer", proposal: 1, yes: true },
        { kind: "vote", motion: 1, ballot: "yes" },
        64,
      ],
    ];
    for (const [guest, room, engine, at] of steps) {
      expect(engineAction(room)).toEqual(engine);
      a.tick(at);
      const want = act(a.state, a.of(guest), engine, later(at));
      expect(a.move(guest, room, at)).toEqual(want);
    }
    expect(a.state.standing?.motion).toBe(1);
  });

  for (const c of CASES)
    it(`refuses as the engine does: ${c.name}`, () => {
      const g = roomMatch(undefined, c.clock);
      c.setup?.(g);
      g.tick(c.at);
      const handle = g.of(c.guest);
      const engine = codeOf(() =>
        act(g.state, handle, engineAction(c.action), later(c.at)),
      );
      const room = codeOf(() =>
        roomAct(g.state, handle, c.action, later(c.at)),
      );
      expect(engine?.code).toBe(c.engine);
      expect(room?.code).toBe(c.room);
      expect(room?.status).toBe(c.room === "empty_text" ? 400 : engine?.status);
      if (c.engine !== "invalid_text")
        expect(REFUSAL_OF[c.engine]).toBe(c.room);
      expect(room?.message).not.toMatch(/[{}]/);
      expect(forbiddenIn(room?.message ?? "")).toEqual([]);
      for (const h of HANDLES) expect(room?.message).not.toContain(h);
    });

  it("fills a refusal's numbers from the room's own state", () => {
    const g = roomMatch();
    g.propose("Avery", S1, 61);
    const m = (f: () => unknown) => codeOf(f)?.message;
    expect(
      m(() =>
        roomAct(
          g.state,
          g.of("Avery"),
          { kind: "propose", seating: S2 },
          later(62),
        ),
      ),
    ).toBe("Your proposal 1 is still open: one at a time.");
    expect(
      m(() =>
        roomAct(
          g.state,
          g.of("Devon"),
          { kind: "propose", seating: S1 },
          later(62),
        ),
      ),
    ).toBe("That seating is already open as proposal 1.");
    expect(
      m(() =>
        roomAct(
          g.state,
          g.of("Devon"),
          { kind: "say", text: "deal?‍" },
          later(62),
        ),
      ),
    ).toBe(
      "Use plain visible text. This message has an invisible or joining character, U+200D; drop it and send again.",
    );
    const fresh = roomMatch();
    expect(
      m(() =>
        roomAct(
          fresh.state,
          fresh.of("Avery"),
          { kind: "propose", seating: S1 },
          later(10),
        ),
      ),
    ).toBe(`Proposals open at ${later(60).toISOString()}. Talk until then.`);
  });

  it("maps every refusal the engine can make for these moves", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/floor/game.ts"),
      "utf8",
    );
    const codes = new Set(
      [...source.matchAll(/(?:refuse|invalid)\(\s*"([a-z_]+)"/g)].map(
        (x) => x[1] as string,
      ),
    );
    // Never reached from a room: a seat is always seated, an answer always
    // names its proposal, and a room has no naming.
    const unreachable = [
      "not_seated",
      "no_motion",
      "unknown_executive",
      "naming_yourself",
      "invalid_guess",
      "already_named",
    ];
    for (const code of codes)
      expect(
        code in REFUSAL_OF || unreachable.includes(code),
        `${code} has no room words`,
      ).toBe(true);
    for (const c of CASES) codes.delete(c.engine);
    expect([...codes].sort()).toEqual([...unreachable].sort());
  });
});

describe("the page's own words", () => {
  const texts = [
    NOTICE,
    ...Object.entries(REFUSALS).map(
      ([k]) =>
        refusal(400, k as keyof typeof REFUSALS, {
          char: "U+200D",
          chars: "600",
          messages: "40",
          proposals: "3",
          proposal: "2",
          at: later(60).toISOString(),
          seconds: "30",
          seats: "Blake, Casey, Devon, Emery",
        }).message,
    ),
    ...ARMS.map(whoFor),
  ];

  it("use no word on the list, nothing invisible, and say nothing of who holds a seat", () => {
    for (const t of texts) {
      expect(forbiddenIn(t), t).toEqual([]);
      expect(RESEARCH.test(t), t).toBe(false);
      expect(invisibleIn(t), t).toBe(false);
      expect(t).not.toMatch(/[{}]/);
      if (!ARMS.map(whoFor).includes(t))
        expect(IDENTITY.test(t), t).toBe(false);
    }
  });
});
