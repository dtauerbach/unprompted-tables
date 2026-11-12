import { db } from "./db";
import { ApiError } from "./http";

// A long-poll: a delta read that waits for something new instead of
// answering "nothing yet", so a bot can wait in a shell loop with no model
// turn per check. Every two seconds the server asks the database one small
// question about the match (how many events, is a deadline due), and makes
// the reader's own read again only when that changed, a deadline passed,
// or every fifth tick; it answers as soon as the reader's own answer
// changes. The decision to answer looks only at that answer, which shows
// nothing hidden from the reader, so something private to others landing
// during the wait never makes it answer sooner, and the moment a wait
// ends says no more than a read every two seconds would. Ticks fall at
// fixed times from the start, not after each read, so how long a read
// takes doesn't move them.
//
// Only a player seated in the match may wait, at most two waits at a time
// per player per match on one server, and never on a match that is over.

export const MAX_WAIT = 25;
const EVERY_MS = 2000;
const FULL_EVERY = 5;
const SAME_READER = 2;

// The `wait` a read was asked with, in whole seconds: 0 when absent.
export function waitParam(req: Request): number {
  const raw = new URL(req.url).searchParams.get("wait");
  if (raw === null) return 0;
  if (!/^\d{1,2}$/.test(raw) || Number(raw) > MAX_WAIT)
    throw new ApiError(
      400,
      "invalid_wait",
      `wait is a whole number of seconds from 0 to ${MAX_WAIT}.`,
    );
  return Number(raw);
}

// What a delta answer looks like here: its events since the cursor (none
// on a quiet read), a resync mark, the phase, and the reader's next
// cursor, which is sealed afresh each time and so is left out of the
// comparison.
type Answer = {
  events?: unknown;
  resync?: unknown;
  next?: unknown;
  phase?: unknown;
};

function quiet(answer: object): boolean {
  const a = answer as Answer;
  return Array.isArray(a.events) && a.events.length === 0 && !a.resync;
}

function state(answer: object): string {
  const { next: _next, ...rest } = answer as Answer;
  return JSON.stringify(rest);
}

// One small question about a match: a stamp that changes when an event is
// stored, and whether its next deadline has passed by the Table's clock.
export type Probe = { stamp: string; due: boolean };

// Waiters on one match on this server share one probe at a time.
const probes = new Map<string, { at: number; answer: Promise<Probe> }>();

export function probeMatch(
  table: string,
  id: string,
  offsetMs: () => number,
): Promise<Probe> {
  const key = `${table}\n${id}`;
  const held = probes.get(key);
  if (held && Date.now() - held.at < EVERY_MS / 2) return held.answer;
  const answer = (async () => {
    const [row] = await db()<{ n: number; due: Date | null; t: Date }[]>`
      SELECT (SELECT count(*)::int FROM events WHERE match_id = ${id}) AS n,
             (SELECT due FROM open_matches WHERE match_id = ${id}) AS due,
             now() AS t`;
    if (!row) throw new Error("the probe got no row");
    return {
      stamp: String(row.n),
      due:
        row.due !== null && row.t.getTime() + offsetMs() >= row.due.getTime(),
    };
  })();
  probes.set(key, { at: Date.now(), answer });
  answer.catch(() => probes.delete(key));
  if (probes.size > 1000)
    for (const [k, v] of probes)
      if (Date.now() - v.at > EVERY_MS) probes.delete(k);
  return answer;
}

const waiting = new Map<string, number>();

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

// Reads once and, while the answer is quiet, waits up to `seconds` for it
// to change, answering the first one that differs, or the last quiet one.
// `seated` says whether the reader is a player in the match; `probe` is
// the cheap question asked between reads; `reader` names the reader and
// match for the cap on waits at once. A read that fails during the wait
// ends it with the last quiet answer. A caller that hangs up ends the wait
// where the platform passes the hang-up on (`signal`); on Vercel that
// needs request cancellation turned on, which these routes don't, so
// there an abandoned wait runs out its time, holding no connection.
export async function waitForNews<T extends object>(
  read: () => Promise<T>,
  seconds: number,
  opts: {
    seated?: (first: T) => boolean;
    probe?: () => Promise<Probe>;
    reader?: string;
    signal?: AbortSignal;
    everyMs?: number;
  } = {},
): Promise<T> {
  const first = await read();
  if (seconds <= 0) return first;
  if (opts.seated && !opts.seated(first))
    throw new ApiError(
      403,
      "wait_for_players",
      "Only a player seated in this match may wait. Read without wait.",
    );
  if (!quiet(first)) return first;
  if ((first as Answer).phase === "over")
    throw new ApiError(
      409,
      "match_over",
      "This match is over, so there is nothing to wait for. Read it without wait.",
    );
  const reader = opts.reader;
  if (reader !== undefined) {
    const n = waiting.get(reader) ?? 0;
    if (n >= SAME_READER) return first;
    waiting.set(reader, n + 1);
  }
  try {
    return await hold(first, read, seconds, opts);
  } finally {
    if (reader !== undefined) {
      const n = (waiting.get(reader) ?? 1) - 1;
      if (n > 0) waiting.set(reader, n);
      else waiting.delete(reader);
    }
  }
}

async function hold<T extends object>(
  first: T,
  read: () => Promise<T>,
  seconds: number,
  opts: {
    probe?: () => Promise<Probe>;
    signal?: AbortSignal;
    everyMs?: number;
  },
): Promise<T> {
  const every = opts.everyMs ?? EVERY_MS;
  const start = Date.now();
  const deadline = start + seconds * 1000;
  const was = state(first);
  const ask = async () => {
    try {
      return await opts.probe?.();
    } catch {
      return undefined;
    }
  };
  let seen = await ask();
  let last = first;
  for (let tick = 1; ; tick++) {
    const at = Math.min(start + tick * every, deadline);
    await pause(at - Date.now(), opts.signal);
    if (opts.signal?.aborted) return last;
    const end = at >= deadline;
    const now = opts.probe ? await ask() : undefined;
    const full =
      !opts.probe ||
      end ||
      tick % FULL_EVERY === 0 ||
      now === undefined ||
      seen === undefined ||
      now.due ||
      now.stamp !== seen.stamp;
    if (full) {
      try {
        last = await read();
      } catch {
        return last;
      }
      seen = now;
      if (!quiet(last) || state(last) !== was) return last;
    }
    if (end) return last;
  }
}
