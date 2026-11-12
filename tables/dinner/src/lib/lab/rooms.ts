import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HANDLE_RE } from "@unprompted-tables/game";
import { siteUrl } from "@unprompted-tables/server";
import { z } from "zod";
import committed from "../../../content/lab/rooms.json";
import { FLOOR_VARIANTS, type FloorVariant } from "../floor/variants";
import { ARMS } from "./texts";

// Rooms: closed open-floor matches for an experiment (docs/LAB.md). Each
// room is committed in content/lab/rooms.json: its id, its pair, its arm,
// the five handles that may sit in it, in seat order, the window in which
// seats can be taken, and its clock. Two rooms make a pair: the same five
// handles in the same order, the same clock, one room an arm. A pair's
// seed is derived from its name (pairSeed), so both rooms deal alike. A
// rehearsal may instead be a pair of one room.
//
// The file also names the host a room's address is built from: a neutral
// name, never TABLE_URL, which names the site.

const ROOM_ID = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);

// A room's clock: today's feud, with only its timing changed. The guide's
// words fix every other number (three proposals, forty messages of 600
// characters, three yes), so a clock may change nothing else.
const feud = FLOOR_VARIANTS.feud as FloorVariant;
export const ROOM_CLOCKS = {
  feud: { ...feud, name: "room-feud" },
  // The rehearsal: cards between 8 and 9 minutes.
  rehearsal: {
    ...feud,
    name: "room-rehearsal",
    floor_opens: 60,
    vote_seconds: 60,
    served: { from: 480, to: 540, step: 1 },
  },
  // For evals and tests only: cards between 2 and 3 minutes. The committed
  // rooms never use it (src/lib/lab/rooms.test.ts).
  quick: {
    ...feud,
    name: "room-quick",
    floor_opens: 60,
    vote_seconds: 60,
    served: { from: 120, to: 180, step: 1 },
  },
} satisfies Record<string, FloorVariant>;
export type ClockName = keyof typeof ROOM_CLOCKS;

const iso = z.iso.datetime({ offset: true });

export const roomSchema = z
  .strictObject({
    id: ROOM_ID,
    pair: ROOM_ID,
    arm: z.enum(ARMS),
    // Seat order: the same in both rooms of a pair, so each handle gets
    // the same guest twice.
    handles: z
      .array(z.string().regex(HANDLE_RE))
      .length(5)
      .refine((hs) => new Set(hs).size === hs.length, {
        message: "a room's five handles are distinct",
      }),
    // When seats can be taken: from, inclusive, to to, exclusive.
    window: z
      .strictObject({ from: iso, to: iso })
      .refine((w) => Date.parse(w.from) < Date.parse(w.to), {
        message: "a window runs forward",
      }),
    clock: z.enum(Object.keys(ROOM_CLOCKS) as [ClockName, ...ClockName[]]),
  })
  .readonly();
export type Room = z.output<typeof roomSchema>;

// https, unless the Table's own site is local (evals and dev).
const hostSchema = z
  .string()
  .regex(/^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/);

export const roomsFileSchema = z
  .strictObject({
    about: z.string(),
    host: hostSchema,
    rooms: z.array(roomSchema),
  })
  .superRefine((f, ctx) => {
    const ids = new Set<string>();
    const pairs = new Map<string, Room[]>();
    for (const r of f.rooms) {
      if (ids.has(r.id))
        ctx.addIssue({ code: "custom", message: `room ${r.id} twice` });
      ids.add(r.id);
      pairs.set(r.pair, [...(pairs.get(r.pair) ?? []), r]);
    }
    for (const [pair, rs] of pairs) {
      const [a, b] = rs;
      // A rehearsal may play alone: one room, a pair of its own, so it
      // shares no deal with any other room. Nothing compares it with a
      // twin, and its record says it has none.
      if (rs.length === 1 && a?.clock === "rehearsal") continue;
      if (
        rs.length !== 2 ||
        !a ||
        !b ||
        a.arm === b.arm ||
        a.handles.join() !== b.handles.join() ||
        a.clock !== b.clock
      )
        ctx.addIssue({
          code: "custom",
          message: `pair ${pair} needs two rooms, one an arm, with the same handles in the same order and the same clock (only a rehearsal plays alone)`,
        });
    }
  });
export type RoomsFile = z.output<typeof roomsFileSchema>;

// Another rooms file, for a local run only (below): read at run time, so
// it's no part of the build.
function readRoomsFile(file: string): RoomsFile {
  const at = path.resolve(/*turbopackIgnore: true*/ file);
  return roomsFileSchema.parse(
    JSON.parse(readFileSync(/*turbopackIgnore: true*/ at, "utf8")),
  );
}

// The rooms in force: the committed file, or, only when this Table's site is
// local (an eval or a dev run), the file LAB_ROOMS_FILE names. A deploy that
// talks to the real site can't be pointed at rooms nobody committed.
let loaded: RoomsFile | null = null;
export function roomsFile(): RoomsFile {
  if (loaded) return loaded;
  const other = process.env.LAB_ROOMS_FILE;
  if (other) {
    const host = new URL(siteUrl()).hostname;
    if (host !== "localhost" && host !== "127.0.0.1")
      throw new Error("LAB_ROOMS_FILE is for a local site only");
  }
  loaded = other ? readRoomsFile(other) : roomsFileSchema.parse(committed);
  return loaded;
}

// Tests set the rooms directly; null goes back to the file.
export function setRoomsForTests(f: RoomsFile | null): void {
  if (!process.env.VITEST) throw new Error("only tests set rooms");
  loaded = f === null ? null : roomsFileSchema.parse(f);
}

export function roomById(id: string): Room | null {
  return roomsFile().rooms.find((r) => r.id === id) ?? null;
}

export const clockOf = (r: Room): FloorVariant => ROOM_CLOCKS[r.clock];

export function windowOpen(r: Room, at: Date): boolean {
  const t = at.getTime();
  return Date.parse(r.window.from) <= t && t < Date.parse(r.window.to);
}

// A pair's seed: an HMAC of its name under the Table's existing secret, so
// both rooms deal alike and no seed sits in the public repo. A production
// server refuses to derive one without the secret, as hashIp does.
export function pairSeed(pair: string): string {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("IP_HASH_SECRET is not set");
  return createHmac("sha256", secret ?? "dev-only")
    .update(`lab-pair\0${pair}`)
    .digest("hex")
    .slice(0, 32);
}
