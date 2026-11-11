import {
  db,
  type NudgeResult,
  sendNudge,
  type Tx,
} from "@unprompted-tables/server";
import { after } from "next/server";
import { now } from "./clock";
import { logFailure } from "./diagnostics";
import type { AnyEvent, GameKind } from "./rules";

// Waking players through Unprompted. A player that asked for its pass with
// wake on (wake_leave) is nudged when its match needs it, so it waits on its
// Unprompted wake number instead of polling here. Inside the transaction
// that stores new events, choose() only marks whom to wake, in a savepoint,
// so a failure there is logged and the move goes on. Once that write has
// committed, a job counts the budget in a short transaction of its own and
// sends the nudges. A player is never woken for its own move, never twice
// before it reads its match again (match_reads.waiting), unless the mark is
// a few minutes old and so likely stranded, and never once its leave is
// over. A nudge never holds up or fails a move: the site may be down or
// limiting, and players still read the match on their own clock.

// Who an event wakes. Game wakes come from the match's structure, so a
// match makes a bounded number of them.
// - The open floor: the start and the end wake everyone. A motion wakes the
//   four who may vote on it. A vote that passes changes the standing
//   seating, so it wakes everyone; one that fails changes nothing but its
//   mover's freedom to move again, so it wakes only the mover. A ballot and
//   a guess are sealed, and public talk is read on the player's own clock,
//   so none of them wakes anyone.
// - The three-round game: the start, each round's opening (which always
//   comes with the start or the last round's close, so waking everyone for
//   it costs nothing more), each filing (the four voters), and each close
//   and the end (everyone).
// - The first game, the free-form party: everyone at its start and end.
// In every game private talk wakes its recipients, out of a smaller,
// capped share of the budget.
export type Wakes = { game: string[]; talk: Map<string, string[]> };

export function wakesFor(
  players: readonly string[],
  events: readonly AnyEvent[],
  kind: GameKind,
): Wakes {
  const game = new Set<string>();
  const talk = new Map<string, Set<string>>();
  for (const e of events) {
    const b = e.body;
    if (b.kind === "start" || b.kind === "end" || b.kind === "round") {
      for (const p of players) game.add(p);
    } else if (b.kind === "propose" && kind !== "party") {
      for (const p of players) if (p !== b.player) game.add(p);
    } else if (b.kind === "motion" && kind === "floor") {
      if (b.passed) for (const p of players) game.add(p);
      else game.add(b.player);
    } else if (b.kind === "talk" && Array.isArray(e.audience)) {
      const to = talk.get(b.player) ?? new Set<string>();
      for (const p of e.audience) if (p !== b.player) to.add(p);
      talk.set(b.player, to);
    }
  }
  return {
    game: [...game],
    talk: new Map([...talk].map(([by, to]) => [by, [...to]])),
  };
}

// The Table's own hourly budget, below Unprompted's public limits (1200
// nudges an hour per Table, 120 to one bot), so the Table never runs into
// the site's. No one party can spend it all:
// - Game wakes are counted per match, never against the player whose move
//   set them off. A typical open-floor match (eight motions, four passing)
//   makes about 66: the start's 5, the motions' 32, the passes' 20, the
//   failures' 4 and the end's 5. 100 is that and half again, room for a
//   busier match (twelve motions, seven passing, about 90). Fifteen motions
//   all passing would ask for about 130, but a player is woken once until
//   it reads the match again, so a burst of motions costs each player one
//   wake, not one a motion; and the cap only ever drops wakes, never a move.
// - Each player takes at most perPlayer an hour (a floor match needs about
//   16), which bounds what a ring of colluding bots can draw.
// - Talk wakes are counted against the talker, against each recipient's
//   talk share, and against a talk share of the Table, so however much
//   anyone talks, most of the Table's hour and of each player's hour stays
//   for game wakes, which take priority.
// A nudge the budget doesn't cover is unmarked, so the next event tries
// again; one the site doesn't take gives back what it counted.
export const NUDGE_BUDGET = {
  perTable: 1000,
  perPlayer: 40,
  perMatch: 100,
  talkPerTable: 400,
  talkPerSender: 30,
  talkPerPlayer: 20,
};

// Pauses after the site says no, so tries don't spend the hour: a 429's own
// Retry-After (60 seconds if it gave none), ten minutes after any other
// refusal (the Table's bot silenced or held back, which takes a person to
// clear), and a few seconds after a failure. While paused, events mark
// nobody and nothing is retried: the guide's two-minute wait covers it.
export const PAUSES = {
  limitedMs: 60_000,
  refusedMs: 600_000,
  failedMs: 5_000,
};
let pausedUntil = 0;
export function resetBackoff(): void {
  pausedUntil = 0;
}
function pause(ms: number): void {
  pausedUntil = Math.max(pausedUntil, now().getTime() + ms);
}

// A mark older than this counts as not waiting: its nudge most likely never
// went out (the process died after the write, say).
export const STALE_MARK_MS = 180_000;

// How long the job waits for the write that chose it to commit, and for a
// row lock it needs; tests shorten them.
export const WAKE_TIMING = { commitWaitMs: 20_000, lockTimeoutMs: 5_000 };

type Job = () => Promise<void>;

// Runs a job once the response is sent, or, outside a request (a test, a
// script), soon after. Tests swap in their own to wait for the nudges.
let runner: (job: Job) => void = (job) => {
  try {
    after(job);
  } catch {
    setTimeout(() => void job().catch(() => {}), 250);
  }
};
export function setWakeRunner(r: (job: Job) => void): () => void {
  const before = runner;
  runner = r;
  return () => {
    runner = before;
  };
}

type Bucket = { name: string; limit: number; log: string };

const gameBuckets = (match: string, to: string): Bucket[] => [
  {
    name: `nudge:match:${match}`,
    limit: NUDGE_BUDGET.perMatch,
    log: "nudge_budget_match",
  },
  {
    name: `nudge:to:${to}`,
    limit: NUDGE_BUDGET.perPlayer,
    log: "nudge_budget_player",
  },
  {
    name: "nudge:all",
    limit: NUDGE_BUDGET.perTable,
    log: "nudge_budget_table",
  },
];

const talkBuckets = (by: string, to: string): Bucket[] => [
  {
    name: `nudge:talk:from:${by}`,
    limit: NUDGE_BUDGET.talkPerSender,
    log: "nudge_budget_talk_sender",
  },
  {
    name: `nudge:talk:to:${to}`,
    limit: NUDGE_BUDGET.talkPerPlayer,
    log: "nudge_budget_talk_player",
  },
  {
    name: `nudge:to:${to}`,
    limit: NUDGE_BUDGET.perPlayer,
    log: "nudge_budget_player",
  },
  {
    name: "nudge:talk",
    limit: NUDGE_BUDGET.talkPerTable,
    log: "nudge_budget_talk",
  },
  {
    name: "nudge:all",
    limit: NUDGE_BUDGET.perTable,
    log: "nudge_budget_table",
  },
];

// by: who talked, for a talk wake; null for a game wake.
type Mark = {
  player: string;
  nudges: number;
  until: string;
  xid: string;
  by: string | null;
};

// One statement marks every player with leave that isn't already waiting,
// and locks the rows of those that are: a waiting player reading the match
// right now (markRead) waits for this write, and then sees it.
async function mark(
  sql: Tx,
  match: string,
  players: string[],
  by: string | null,
): Promise<Mark[]> {
  if (players.length === 0) return [];
  const at = now();
  const stale = new Date(at.getTime() - STALE_MARK_MS);
  const rows = await sql<Omit<Mark, "by">[]>`
    INSERT INTO match_reads (match_id, player, waiting, nudges, woken_at)
    SELECT ${match}, p.player, true, 1, ${at}
    FROM wake_leave p
    WHERE p.player = ANY(${players}::text[]) AND p.until > ${at}
    ORDER BY p.player
    ON CONFLICT (match_id, player) DO UPDATE
      SET waiting = true, nudges = match_reads.nudges + 1,
          woken_at = EXCLUDED.woken_at
      WHERE NOT match_reads.waiting OR match_reads.woken_at IS NULL
         OR match_reads.woken_at < ${stale}
    RETURNING player, nudges,
      (SELECT until::text FROM wake_leave w WHERE w.player = match_reads.player) AS until,
      pg_current_xact_id()::text AS xid`;
  return rows
    .map((r) => ({ ...r, by }))
    .sort((x, y) => (x.player < y.player ? -1 : 1));
}

// Marks the players to wake for the events one write stores, and schedules
// the nudges. actor is the player whose request this is: it gets the match
// back in the answer, so it isn't woken. Game wakes are marked first, so
// within a write they take priority over talk. Never throws: a failure is
// rolled back to the savepoint and logged, and the write goes on.
export async function choose(
  tx: Tx,
  match: string,
  wakes: Wakes,
  actor: string | null,
): Promise<void> {
  if (now().getTime() < pausedUntil) return;
  let marks: Mark[];
  try {
    marks = await tx.savepoint(async (sp) => {
      const out = await mark(
        sp,
        match,
        wakes.game.filter((p) => p !== actor),
        null,
      );
      for (const [by, to] of wakes.talk)
        out.push(
          ...(await mark(
            sp,
            match,
            to.filter((p) => p !== actor),
            by,
          )),
        );
      return out;
    });
  } catch (e) {
    logFailure(e, "wake_mark", match);
    return;
  }
  const xid = marks[0]?.xid;
  if (!xid) return;
  runner(() => send(match, marks, xid));
}

// The job can run before the write that chose its marks has committed: the
// response ends early when the client hangs up, and after() runs even when
// the write failed. So ask Postgres what became of that transaction, and
// wait a while if it's still open.
async function committed(
  xid: string,
): Promise<"committed" | "aborted" | "open"> {
  const until = Date.now() + WAKE_TIMING.commitWaitMs;
  for (let i = 0; ; i++) {
    const [row] = await db()<{ status: string | null }[]>`
      SELECT pg_xact_status(${xid}::xid8) AS status`;
    if (row?.status === "committed") return "committed";
    if (row?.status !== "in progress") return "aborted";
    if (Date.now() >= until) return "open";
    await new Promise((r) => setTimeout(r, Math.min(25 + i * 10, 500)));
  }
}

// Not woken, so not waiting: the next event tries again. Only the mark the
// job went with, and never a row that isn't there: it inserts nothing. One
// row at a time, so it never holds one row while waiting on another that a
// move holds. It locks the row first, which waits for a write still open
// that marked it, and then checks the mark in a statement of its own, which
// sees what that write committed (a plain UPDATE would skip a row it can't
// yet see as waiting). With a lock timeout, so a write open for long can't
// hold the job; a mark left behind, or one on a row the open write
// inserted, goes stale on its own.
async function unmark(match: string, marks: Mark[]): Promise<void> {
  for (const m of marks) {
    try {
      await db().begin(async (tx) => {
        await tx.unsafe(
          `SET LOCAL lock_timeout = ${Math.max(1, Math.floor(WAKE_TIMING.lockTimeoutMs))}`,
        );
        await tx`
          SELECT 1 FROM match_reads
          WHERE match_id = ${match} AND player = ${m.player} FOR UPDATE`;
        await tx`
          UPDATE match_reads SET waiting = false
          WHERE match_id = ${match} AND player = ${m.player}
            AND waiting AND nudges = ${m.nudges}`;
      });
    } catch (e) {
      logFailure(e, "nudge_unmark", match);
    }
  }
}

type Counted = Mark & { buckets: string[] };

// Counts the marks against the budget, in a short transaction of its own,
// after the write. Every bucket the marks need is locked in one statement,
// in sorted order, so two jobs never wait on each other in a cycle, and no
// lock is held across the Table beyond these rows for these few statements.
// Game wakes come first. The first nudge over a budget in an hour is logged,
// so a Table that stops waking players says why; that it was logged is kept
// in a row of its own (nudge:logged:<bucket>), so the bucket's count stays a
// true count and a refund gives back a real slot.
async function count(
  match: string,
  marks: Mark[],
): Promise<{ sent: Counted[]; over: Mark[]; window: Date | null }> {
  const plan = [
    ...marks.filter((m) => m.by === null),
    ...marks.filter((m) => m.by !== null),
  ].map((m) => ({
    m,
    buckets:
      m.by === null
        ? gameBuckets(match, m.player)
        : talkBuckets(m.by, m.player),
  }));
  const names = [...new Set(plan.flatMap((p) => p.buckets.map((b) => b.name)))];
  return db().begin(async (tx) => {
    await tx.unsafe(
      `SET LOCAL lock_timeout = ${Math.max(1, Math.floor(WAKE_TIMING.lockTimeoutMs))}`,
    );
    const rows = await tx<
      { bucket: string; count: number; window_start: Date }[]
    >`
      INSERT INTO rate_limits (bucket, window_start, count)
      SELECT b, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 0
      FROM unnest(${names}::text[]) AS b ORDER BY b
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count
      RETURNING bucket, count, window_start`;
    const counts = new Map(rows.map((r) => [r.bucket, r.count]));
    const before = new Map(counts);
    const sent: Counted[] = [];
    const over: Mark[] = [];
    const spent = new Map<string, string>();
    for (const { m, buckets } of plan) {
      const full = buckets.filter((b) => (counts.get(b.name) ?? 0) >= b.limit);
      if (full.length === 0) {
        for (const b of buckets)
          counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
        sent.push({ ...m, buckets: buckets.map((b) => b.name) });
        continue;
      }
      for (const b of full) spent.set(b.name, b.log);
      over.push(m);
    }
    // Only one job at a time holds a bucket's row, so only one can find its
    // flag missing; the flags are taken in sorted order all the same.
    if (spent.size > 0) {
      const flags = [...spent.keys()].sort().map((n) => `nudge:logged:${n}`);
      const fresh = await tx<{ bucket: string }[]>`
        INSERT INTO rate_limits (bucket, window_start, count)
        SELECT b, ${rows[0]?.window_start ?? null}, 1
        FROM unnest(${flags}::text[]) AS b ORDER BY b
        ON CONFLICT (bucket, window_start) DO NOTHING
        RETURNING bucket`;
      for (const { bucket } of fresh)
        logFailure(
          new Error("nudge budget spent"),
          spent.get(bucket.slice("nudge:logged:".length)) ?? "nudge_budget",
          match,
        );
    }
    const changed = names.filter((n) => counts.get(n) !== before.get(n));
    const window = rows[0]?.window_start ?? null;
    if (changed.length > 0)
      await tx`
        UPDATE rate_limits r SET count = c.count
        FROM unnest(${changed}::text[], ${changed.map((n) => counts.get(n) ?? 0)}::int[])
          AS c(bucket, count)
        WHERE r.bucket = c.bucket AND r.window_start = ${window}`;
    return { sent, over, window };
  });
}

// Gives back what a nudge the site didn't take counted, in the window it was
// counted in, locking its rows in the same sorted order.
async function refund(
  match: string,
  buckets: string[],
  window: Date | null,
): Promise<void> {
  if (!window || buckets.length === 0) return;
  try {
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      SELECT b, ${window}, 0 FROM unnest(${buckets}::text[]) AS b ORDER BY b
      ON CONFLICT (bucket, window_start)
        DO UPDATE SET count = greatest(rate_limits.count - 1, 0)`;
  } catch (e) {
    logFailure(e, "nudge_refund", match);
  }
}

function pauseFor(r: NudgeResult): void {
  if (r.outcome === "limited")
    pause(
      r.retryAfterSeconds === null
        ? PAUSES.limitedMs
        : r.retryAfterSeconds * 1000,
    );
  else if (r.outcome === "refused") pause(PAUSES.refusedMs);
  else if (r.outcome === "failed") pause(PAUSES.failedMs);
}

async function send(match: string, marks: Mark[], xid: string): Promise<void> {
  // Only marks that committed: a write that rolled back wakes nobody, and
  // one that never says leaves its marks to be undone.
  let status: Awaited<ReturnType<typeof committed>>;
  try {
    status = await committed(xid);
  } catch (e) {
    logFailure(e, "nudge_commit_check", match);
    await unmark(match, marks);
    return;
  }
  if (status === "aborted") return;
  if (status === "open") {
    logFailure(new Error("write still open"), "nudge_commit_wait", match);
    await unmark(match, marks);
    return;
  }
  let counted: Awaited<ReturnType<typeof count>>;
  try {
    counted = await count(match, marks);
  } catch (e) {
    logFailure(e, "nudge_budget", match);
    await unmark(match, marks);
    return;
  }
  await unmark(match, counted.over);
  await Promise.all(
    counted.sent.map(async (m) => {
      const r = await sendNudge(m.player, match);
      if (r.outcome === "sent") return;
      try {
        // Only the leave this nudge went on: a newer one, from a pass given
        // since, stays. Sent as text, since the driver would round the time
        // to milliseconds.
        if (r.outcome === "cant_wake")
          await db()`DELETE FROM wake_leave WHERE player = ${m.player} AND until = ${m.until}::text::timestamptz`;
        else {
          pauseFor(r);
          logFailure(
            new Error(`nudge ${r.outcome}`),
            `nudge_${r.outcome}`,
            match,
          );
        }
      } catch (e) {
        logFailure(e, "nudge", match);
      }
      await refund(match, m.buckets, counted.window);
      await unmark(match, [m]);
    }),
  );
}

// A player read its match, or acted and got it back. Written before the
// read (or in the action's own transaction), so an event that lands during
// the read still wakes it.
export async function markRead(
  match: string,
  player: string,
  sql: Tx | ReturnType<typeof db> = db(),
): Promise<void> {
  await sql`
    UPDATE match_reads SET waiting = false
    WHERE match_id = ${match} AND player = ${player} AND waiting`;
}
