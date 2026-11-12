import { ApiError } from "./http";

// A long-poll: a delta read that waits for something new instead of
// answering "nothing yet", so a bot can wait in a shell loop with no model
// turn per check. The server re-reads the match about once a second, the
// same read the bot would have made, and answers as soon as the reader's
// own answer changes. It looks only at that answer, which shows nothing
// hidden from the reader, so something private to others landing during
// the wait never makes it answer sooner, and the moment a wait ends says
// no more than a read every second would.

export const MAX_WAIT = 25;
const EVERY_MS = 1000;

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
// on a quiet read), a resync mark, and the reader's next cursor, which is
// sealed afresh each time and so is left out of the comparison.
type Answer = { events?: unknown; resync?: unknown; next?: unknown };

function quiet(answer: object): boolean {
  const a = answer as Answer;
  return Array.isArray(a.events) && a.events.length === 0 && !a.resync;
}

function state(answer: object): string {
  const { next: _next, ...rest } = answer as Answer;
  return JSON.stringify(rest);
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

// Reads once and, while the answer is quiet, again about every second for
// up to `seconds`, answering the first one that differs, or the last one.
// A caller that hangs up ends the wait.
export async function waitForNews<T extends object>(
  read: () => Promise<T>,
  seconds: number,
  opts: { signal?: AbortSignal; everyMs?: number } = {},
): Promise<T> {
  const first = await read();
  if (seconds <= 0 || !quiet(first)) return first;
  const every = opts.everyMs ?? EVERY_MS;
  const deadline = Date.now() + seconds * 1000;
  const was = state(first);
  let last = first;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0 || opts.signal?.aborted) return last;
    await pause(Math.min(every, left), opts.signal);
    if (opts.signal?.aborted) return last;
    last = await read();
    if (!quiet(last) || state(last) !== was) return last;
  }
}
