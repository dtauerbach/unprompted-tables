import {
  bearerToken,
  consume,
  db,
  hashToken,
  isReadOnly,
  newToken,
  redeemPass,
  siteUrl,
  tokenRe,
} from "@unprompted-tables/server";
import { z } from "zod";
import { now, tableNow } from "../clock";
import { logFailure } from "../diagnostics";
import { EXECUTIVES } from "../floor/game";
import { castFor, dealFor } from "../floor/generate";
import { sessionRules } from "../limits";
import { SETTINGS } from "../settings";
import { startRoomMatch } from "../store";
import { refusal } from "./page";
import {
  clockOf,
  pairSeed,
  type Room,
  roomById,
  roomsFile,
  windowOpen,
} from "./rooms";
import { noteFor, reasonsFor } from "./words";

// Taking a seat in a room, and giving it back before the start. The
// fleet's runner, not the bot, trades the bot's pass here for a code; the
// bot only ever holds the code. Every refusal is Hidden, which the route
// answers with the very 404 of an unknown path: a stranger learns nothing,
// not even that the path exists.

export class Hidden extends Error {
  constructor() {
    super("not found");
  }
}

export const SEAT_PREFIX = "seat_";
const SEAT_RE = tokenRe(SEAT_PREFIX);

// The advisory lock space for rooms, keyed by the room's id: seats and the
// start are decided one at a time per room.
const LAB_LOCK = 7_403_002;

export type Seat = { player: string; room: Room };

// Whether the site's public page for this bot shows its test mark. The
// pass proves the handle; this keeps a slip in the rooms file from seating
// a real bot. Read with no key: it's the page anyone can read.
const botPage = z.object({
  bot: z.object({ handle: z.string(), is_test: z.boolean() }),
});
export async function siteSaysTest(handle: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${siteUrl()}/v1/bots/${encodeURIComponent(handle)}`,
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return false;
    const page = botPage.safeParse(await res.json());
    return (
      page.success && page.data.bot.handle === handle && page.data.bot.is_test
    );
  } catch {
    return false;
  }
}

// The guest a handle holds in a room, and its note, from the pair's seed
// alone: the same in both rooms of a pair, and the same as the match's own
// deal once it starts (the deal is drawn exactly as the engine's start
// draws it).
export function seatOf(room: Room, handle: string) {
  const k = room.handles.indexOf(handle);
  if (k < 0) throw new Error("not a seat in this room");
  const seed = pairSeed(room.pair);
  const guest = castFor(seed)[k] as number;
  const v = clockOf(room);
  const d = dealFor(seed, v.level, { margin: v.no_deal_margin });
  return {
    person: EXECUTIVES[guest] as string,
    note: noteFor(
      { weights: d.weights, secrets: d.secrets, reasons: reasonsFor(seed) },
      guest,
    ),
  };
}

// POST /seating/seats {pass, room}: a code for the seat, if and only if
// the pass is good and the site says it proves handle H, H is on the room's
// list, H's public page says it is a test bot, the room's window is open,
// H's seat is free and the room hasn't been played. The fifth seat starts
// the match. Every try counts against the address's session limit.
export async function takeSeat(
  pass: string,
  roomId: string,
  ipHash: string,
): Promise<{ code: string; person: string; note: string; page: string }> {
  if (isReadOnly()) throw new Hidden();
  try {
    await db().begin((tx) => consume(tx, sessionRules(ipHash)));
  } catch {
    throw new Hidden();
  }
  const room = roomById(roomId);
  // Checked before the pass is spent, and again under the room's lock.
  if (!room || !windowOpen(room, now())) throw new Hidden();
  let handle: string;
  try {
    handle = (await redeemPass(pass)).handle;
  } catch {
    throw new Hidden();
  }
  if (!room.handles.includes(handle)) throw new Hidden();
  if (!(await siteSaysTest(handle))) throw new Hidden();
  const { token, hash } = newToken(SEAT_PREFIX);
  await db().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LAB_LOCK}, hashtext(${room.id}))`;
    const at = await tableNow(tx);
    if (!windowOpen(room, at)) throw new Hidden();
    const [played] =
      await tx`SELECT 1 FROM lab_matches WHERE room = ${room.id}`;
    if (played) throw new Hidden();
    // A code that ran out leaves its seat free.
    await tx`DELETE FROM sessions
      WHERE room = ${room.id} AND player = ${handle} AND expires_at <= ${at}`;
    const [taken] = await tx`
      SELECT 1 FROM sessions WHERE room = ${room.id} AND player = ${handle}`;
    if (taken) throw new Hidden();
    await tx`
      INSERT INTO players (handle, on_site_since) VALUES (${handle}, ${at})
      ON CONFLICT (handle) DO NOTHING`;
    await tx`
      INSERT INTO sessions (player, token_hash, expires_at, room)
      VALUES (${handle}, ${hash},
        ${new Date(at.getTime() + SETTINGS.session_seconds * 1000)}, ${room.id})`;
    const [count] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM sessions
      WHERE room = ${room.id} AND expires_at > ${at}`;
    if (count?.n === room.handles.length)
      await startRoomMatch(
        tx,
        room.id,
        [...room.handles],
        clockOf(room),
        pairSeed(room.pair),
      );
  });
  return {
    code: token,
    ...seatOf(room, handle),
    page: roomsFile().host,
  };
}

// The seat a request's code holds, or Hidden. An ordinary session is
// Hidden here, as a seat's code is refused on every ordinary route.
export async function authenticateSeat(req: Request): Promise<Seat> {
  const token = bearerToken(req);
  if (!token || !SEAT_RE.test(token)) throw new Hidden();
  const [row] = await db()<{ player: string; room: string }[]>`
    SELECT player, room FROM sessions
    WHERE token_hash = ${hashToken(token)} AND expires_at > ${now()}
      AND room IS NOT NULL`;
  const room = row ? roomById(row.room) : null;
  if (!row || !room || !room.handles.includes(row.player)) throw new Hidden();
  return { player: row.player, room };
}

// The match a room's seats play, once the fifth seat started it.
export async function roomMatch(room: Room): Promise<string | null> {
  const [row] = await db()<{ match_id: string }[]>`
    SELECT match_id FROM lab_matches WHERE room = ${room.id}`;
  return row?.match_id ?? null;
}

// DELETE /seating/seats: gives the seat back, before the start only. Like
// ending a session, it works while the Table is read-only.
export async function giveBack(req: Request, seat: Seat): Promise<void> {
  const token = bearerToken(req) ?? "";
  await db().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LAB_LOCK}, hashtext(${seat.room.id}))`;
    const [played] =
      await tx`SELECT 1 FROM lab_matches WHERE room = ${seat.room.id}`;
    if (played) throw refusal(409, "started");
    await tx`DELETE FROM sessions
      WHERE token_hash = ${hashToken(token)} AND room = ${seat.room.id}`;
  });
}

export function logRoomFailure(error: unknown): void {
  logFailure(error, "seating");
}
