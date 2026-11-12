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

describe("the committed rooms", () => {
  it("parse, and are only the labelled example, whose windows have closed", () => {
    const f = roomsFile();
    expect(f).toEqual(roomsFileSchema.parse(committed));
    expect(f.about).toMatch(/example only/);
    for (const r of f.rooms) {
      expect(r.pair).toBe("example");
      expect(windowOpen(r, new Date())).toBe(false);
      expect(Date.parse(r.window.to)).toBeLessThan(Date.now());
    }
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
