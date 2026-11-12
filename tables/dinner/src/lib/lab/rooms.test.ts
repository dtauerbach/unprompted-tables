import { afterEach, describe, expect, it } from "vitest";
import committed from "../../../content/lab/rooms.json";
import { floorVariantSchema } from "../floor/variants";
import { forbiddenIn } from "./copy-rules";
import {
  clockOf,
  ROOM_CLOCKS,
  type Room,
  roomById,
  roomsFile,
  roomsFileSchema,
  setRoomsForTests,
  windowOpen,
} from "./rooms";
import { guideFor } from "./texts";

afterEach(() => {
  setRoomsForTests(null);
  delete process.env.LAB_ROOMS_FILE;
});

const HANDLES = ["lab-one", "lab-two", "lab-three", "lab-four", "lab-five"];
const room = (over: Partial<Room> = {}): Room => ({
  id: "p1-control",
  pair: "p1",
  arm: "control",
  handles: HANDLES,
  window: { from: "2026-11-15T02:00:00Z", to: "2026-11-15T02:30:00Z" },
  clock: "feud",
  ...over,
});
const pair = (c: Partial<Room> = {}, t: Partial<Room> = {}) => ({
  about: "test",
  host: "https://seating-desk.vercel.app",
  rooms: [
    room(c),
    room({
      id: "p1-treatment",
      arm: "treatment",
      window: { from: "2026-11-15T04:00:00Z", to: "2026-11-15T04:30:00Z" },
      ...t,
    }),
  ],
});

// The fleet's bots, by their handles on the site: a01, a03, a04, a05 and a10
// (the fleet's ledger maps each agent to its handle). The fleet's own tests
// check its bookings against this file.
const CAST = [
  "fleet-a01-bot",
  "claw-flash-a03",
  "minimax-m31",
  "nemotron-3-5-super-vl",
  "openclaw-sonnet",
];
const HOUR = 3600_000;
const ms = (iso: string) => Date.parse(iso);
const isProbe = (r: Room) => r.id.startsWith("probe-");

describe("the committed rooms", () => {
  it("parse: the real file, through the same schema the Table loads it with", () => {
    const f = roomsFile();
    expect(f).toEqual(roomsFileSchema.parse(committed));
    expect(f.rooms.length).toBeGreaterThan(0);
    expect(f.rooms.map((r) => r.id)).toEqual([
      "probe-1112",
      "rehearsal-1113",
      "pair1-1113-control",
      "pair1-1113-treatment",
    ]);
    for (const r of f.rooms) expect(r.handles).toEqual(CAST);
  });

  it("use a real clock, never the evals' quick one", () => {
    for (const r of roomsFile().rooms)
      expect(["feud", "rehearsal"]).toContain(r.clock);
  });

  it("build addresses from a neutral host", () => {
    const { host } = roomsFile();
    expect(host).toBe("https://seating-desk.vercel.app");
    expect(forbiddenIn(host)).toEqual([]);
    expect(host).not.toMatch(/unprompted|table|dinner|lab|test/i);
  });

  it("make twins of a pair's two rooms: they differ by arm alone, besides their ids and when they open", () => {
    const pairs = new Map<string, Room[]>();
    for (const r of roomsFile().rooms)
      pairs.set(r.pair, [...(pairs.get(r.pair) ?? []), r]);
    const twins = [...pairs.values()].filter((rs) => rs.length === 2);
    expect(twins.length).toBeGreaterThan(0);
    for (const [a, b] of twins as [Room, Room][]) {
      const { id: _a, window: wa, arm: armA, ...restA } = a;
      const { id: _b, window: wb, arm: armB, ...restB } = b;
      expect(restA).toEqual(restB);
      expect(new Set([armA, armB])).toEqual(new Set(["control", "treatment"]));
      // The same length of window, so each seats on the same terms.
      expect(ms(wa.to) - ms(wa.from)).toBe(ms(wb.to) - ms(wb.from));
    }
    // Pair 1 plays control first, then treatment, on the feud's clock.
    const p1 = pairs.get("pair1-1113") as Room[];
    expect(p1.map((r) => r.arm)).toEqual(["control", "treatment"]);
    expect(ms(p1[1]?.window.from as string)).toBeGreaterThan(
      ms(p1[0]?.window.to as string),
    );
    for (const r of p1) expect(r.clock).toBe("feud");
  });

  it("play alone only as a rehearsal, with a pair name no other room shares", () => {
    const f = roomsFile();
    const alone = f.rooms.filter(
      (r) => f.rooms.filter((x) => x.pair === r.pair).length === 1,
    );
    expect(alone.map((r) => r.id)).toEqual(["probe-1112", "rehearsal-1113"]);
    for (const r of alone) {
      expect(r.clock).toBe("rehearsal");
      expect(r.arm).toBe("control");
    }
  });

  it("open each game's window 15 minutes before its booking's hour and close it 45 after, so the wake-up at 47 past seats it", () => {
    for (const r of roomsFile().rooms.filter((x) => !isProbe(x))) {
      const from = new Date(r.window.from);
      expect(from.getUTCMinutes(), r.id).toBe(45);
      expect(from.getUTCSeconds(), r.id).toBe(0);
      expect(ms(r.window.to) - ms(r.window.from), r.id).toBe(HOUR);
      // The booking's start, on the hour.
      const start = ms(r.window.from) + 15 * 60_000;
      expect(start % HOUR, r.id).toBe(0);
    }
  });

  it("keep windows apart, and a probe's closed before any game's opens", () => {
    const rs = [...roomsFile().rooms].sort(
      (a, b) => ms(a.window.from) - ms(b.window.from),
    );
    for (let i = 1; i < rs.length; i++)
      expect(ms(rs[i]?.window.from as string)).toBeGreaterThanOrEqual(
        ms(rs[i - 1]?.window.to as string),
      );
    const games = rs.filter((r) => !isProbe(r));
    for (const p of rs.filter(isProbe))
      for (const g of games)
        expect(ms(p.window.to)).toBeLessThanOrEqual(ms(g.window.from));
  });
});

describe("a room's clock", () => {
  it("changes only the feud's timing, which the guide states in minutes", () => {
    const feud = ROOM_CLOCKS.feud;
    for (const [name, c] of Object.entries(ROOM_CLOCKS)) {
      expect(floorVariantSchema.parse(c)).toEqual(c);
      const { floor_opens, vote_seconds, served, name: n, ...rest } = c;
      const {
        floor_opens: _f,
        vote_seconds: _v,
        served: _s,
        name: _n,
        ...base
      } = feud;
      expect(rest, name).toEqual(base);
      expect(n).toMatch(/^room-/);
      expect(served.step).toBe(1);
      expect(() =>
        guideFor({ arm: "control", person: "Avery", variant: c }),
      ).not.toThrow();
      expect((floor_opens % 60) + (vote_seconds % 60)).toBe(0);
    }
    expect(ROOM_CLOCKS.rehearsal.served).toEqual({
      from: 480,
      to: 540,
      step: 1,
    });
    expect(ROOM_CLOCKS.feud.served).toEqual({ from: 1500, to: 1860, step: 1 });
    expect(clockOf(room({ clock: "rehearsal" }))).toBe(ROOM_CLOCKS.rehearsal);
  });
});

describe("a rooms file", () => {
  it("takes a pair: two rooms, one an arm, the same handles in the same order and the same clock", () => {
    expect(() => roomsFileSchema.parse(pair())).not.toThrow();
    const bad = [
      pair({}, { arm: "control" }),
      pair({}, { handles: [...HANDLES].reverse() }),
      pair({}, { clock: "rehearsal" }),
      pair({}, { id: "p1-control" }),
      { ...pair(), rooms: [room()] },
      pair({
        handles: ["lab-one", "lab-one", "lab-two", "lab-three", "lab-four"],
      }),
      pair({ handles: HANDLES.slice(0, 4) }),
      pair({ handles: [...HANDLES.slice(0, 4), "Not A Handle"] }),
      pair({
        window: { from: "2026-11-15T02:30:00Z", to: "2026-11-15T02:00:00Z" },
      }),
      pair({ clock: "fast" as never }),
      pair({ id: "Room One" }),
      { ...pair(), host: "http://seating-desk.vercel.app" },
      { ...pair(), host: "https://seating-desk.vercel.app/path" },
      { ...pair(), extra: true },
    ];
    for (const b of bad) expect(() => roomsFileSchema.parse(b)).toThrow();
  });

  it("lets a rehearsal play alone, and no other room", () => {
    const lone = (over: Partial<Room>) => ({
      about: "test",
      host: "https://seating-desk.vercel.app",
      rooms: [room({ id: "r1", pair: "r1", ...over })],
    });
    expect(() =>
      roomsFileSchema.parse(lone({ clock: "rehearsal" })),
    ).not.toThrow();
    expect(() =>
      roomsFileSchema.parse(lone({ clock: "rehearsal", arm: "treatment" })),
    ).not.toThrow();
    expect(() => roomsFileSchema.parse(lone({ clock: "feud" }))).toThrow(
      "only a rehearsal plays alone",
    );
    expect(() => roomsFileSchema.parse(lone({ clock: "quick" }))).toThrow();
    // A pair of three is no pair, rehearsal or not.
    const three = pair({ clock: "rehearsal" }, { clock: "rehearsal" });
    three.rooms.push(
      room({ id: "p1-again", clock: "rehearsal", arm: "control" }),
    );
    expect(() => roomsFileSchema.parse(three)).toThrow();
  });

  it("is the committed one unless the site is local", () => {
    process.env.LAB_ROOMS_FILE = "/nowhere/rooms.json";
    expect(() => roomsFile()).toThrow("for a local site only");
    setRoomsForTests(pair());
    expect(roomById("p1-treatment")?.arm).toBe("treatment");
    expect(roomById("nope")).toBeNull();
  });

  it("opens a room's window from its start up to, not at, its end", () => {
    const r = room();
    expect(windowOpen(r, new Date("2026-11-15T01:59:59.999Z"))).toBe(false);
    expect(windowOpen(r, new Date("2026-11-15T02:00:00.000Z"))).toBe(true);
    expect(windowOpen(r, new Date("2026-11-15T02:29:59.999Z"))).toBe(true);
    expect(windowOpen(r, new Date("2026-11-15T02:30:00.000Z"))).toBe(false);
  });
});
