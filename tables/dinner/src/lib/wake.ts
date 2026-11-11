import { db, sendNudge, type Tx } from "@unprompted-tables/server";
import { after } from "next/server";
import { now } from "./clock";
import { logFailure } from "./diagnostics";
import type { AnyEvent } from "./rules";

// Waking players through Unprompted. A player that asked for its pass with
// wake on (wake_leave) is nudged when its match needs it, so it waits on its
// Unprompted wake number instead of polling here. Inside the transaction
// that stores new events, choose() marks whom to wake; once that write has
// committed, the nudges go out, only for marks that committed. A player is
// never woken for its own move, never twice before it reads its match again
// (match_reads.waiting), and never once its leave is over. A nudge never
// holds up or fails a move: the site may be down or limiting, and players
// still read the match on their own clock.

// Who an event wakes. Game wakes come from the match's structure, so a
// match makes a bounded number of them: the start, each round's opening
// (which always comes with the start or the last round's close, so waking
// everyone for it costs nothing more), each filing (the four voters), and
// each close and the end (everyone). A ballot is sealed and public talk is
// read on the player's own clock, so neither wakes anyone. Private talk
// wakes its recipients, out of a smaller, capped share of the budget.
// The first game, the free-form party, wakes everyone at its start and end.
export type Wakes = { game: string[]; talk: Map<string, string[]> };

export function wakesFor(
  players: readonly string[],
  events: readonly AnyEvent[],
  exec: boolean,
): Wakes {
  const game = new Set<string>();
  const talk = new Map<string, Set<string>>();
  for (const e of events) {
    const b = e.body;
    if (b.kind === "start" || b.kind === "end" || b.kind === "round") {
      for (const p of players) game.add(p);
    } else if (b.kind === "propose" && exec) {
      for (const p of players) if (p !== b.player) game.add(p);
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
// - Game wakes are counted per match (a match makes at most a few dozen),
//   never against the player whose move set them off.
// - Talk wakes are counted against the talker, against each recipient's
//   talk share, and against a talk share of the Table, so however much a
//   player talks, most of the Table's hour and of each player's hour stays
//   for game wakes, which take priority.
// A player the budget doesn't cover isn't marked, so the next event tries
// again, and the guide has players read on their own clock anyway.
export const NUDGE_BUDGET = {
  perTable: 1000,
  perPlayer: 100,
  perMatch: 60,
  talkPerTable: 400,
  talkPerSender: 30,
  talkPerPlayer: 30,
};

// After Unprompted says the Table is over a limit, it waits this long before
// choosing anyone again; after the site fails, a few seconds, so an outage
// during a busy match doesn't spend the players' hour on tries.
export const BACKOFF_MS = 60_000;
export const FAILED_PAUSE_MS = 5_000;
let pausedUntil = 0;
export function resetBackoff(): void {
  pausedUntil = 0;
}

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

// Counts one nudge against each budget in the caller's transaction, and
// says whether it fits them all. Unlike consume(), it never refuses the
// write. If one budget is spent, the nudge isn't sent, so the budgets
// counted before it are given back. Buckets are nudge:...; no handle or
// match id holds a colon, so no player's bucket can be another's. The first
// nudge over a budget in an hour is logged, so a Table that stops waking
// players says why.
async function fits(
  tx: Tx,
  match: string,
  buckets: Bucket[],
): Promise<boolean> {
  const counted: string[] = [];
  for (const b of buckets) {
    const [row] = await tx<{ count: number }[]>`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (${b.name}, to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600), 1)
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
      RETURNING count`;
    const count = row?.count ?? 0;
    if (count <= b.limit) {
      counted.push(b.name);
      continue;
    }
    if (count === b.limit + 1)
      logFailure(new Error("nudge budget spent"), b.log, match);
    if (counted.length > 0)
      await tx`
        UPDATE rate_limits SET count = count - 1
        WHERE bucket = ANY(${counted}::text[])
          AND window_start = to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600)`;
    return false;
  }
  return true;
}

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

type Mark = { player: string; nudges: number; until: string; xid: string };

// One statement marks every player with leave that isn't already waiting,
// and locks the rows of those that are: a waiting player reading the match
// right now (markRead) waits for this write, and then sees it. The budget
// then counts only those it just marked, and unmarks the rest, still in
// this transaction, so the next event tries them again.
async function mark(
  tx: Tx,
  match: string,
  players: string[],
  at: Date,
  budget: (player: string) => Bucket[],
): Promise<Mark[]> {
  if (players.length === 0) return [];
  const marked = await tx<Mark[]>`
    INSERT INTO match_reads (match_id, player, waiting, nudges)
    SELECT ${match}, p.player, true, 1
    FROM wake_leave p
    WHERE p.player = ANY(${players}::text[]) AND p.until > ${at}
    ON CONFLICT (match_id, player) DO UPDATE
      SET waiting = true, nudges = match_reads.nudges + 1
      WHERE NOT match_reads.waiting
    RETURNING player, nudges,
      (SELECT until::text FROM wake_leave w WHERE w.player = match_reads.player) AS until,
      pg_current_xact_id()::text AS xid`;
  const kept: Mark[] = [];
  const over: string[] = [];
  for (const row of [...marked].sort((x, y) => (x.player < y.player ? -1 : 1)))
    if (await fits(tx, match, budget(row.player))) kept.push(row);
    else over.push(row.player);
  if (over.length > 0)
    await tx`
      UPDATE match_reads SET waiting = false
      WHERE match_id = ${match} AND player = ANY(${over}::text[])`;
  return kept;
}

// Marks the players to wake for the events one write stores, and schedules
// the nudges. actor is the player whose request this is: it gets the match
// back in the answer, so it isn't woken. Game wakes are marked first, so
// within a write they take priority over talk.
export async function choose(
  tx: Tx,
  match: string,
  wakes: Wakes,
  actor: string | null,
  at: Date,
): Promise<void> {
  if (now().getTime() < pausedUntil) return;
  const rows = await mark(
    tx,
    match,
    wakes.game.filter((p) => p !== actor),
    at,
    (to) => gameBuckets(match, to),
  );
  for (const [by, to] of wakes.talk)
    rows.push(
      ...(await mark(
        tx,
        match,
        to.filter((p) => p !== actor),
        at,
        (p) => talkBuckets(by, p),
      )),
    );
  const xid = rows[0]?.xid;
  if (!xid) return;
  runner(() => send(match, rows, xid));
}

// The job can run before the write that chose its marks has committed: the
// response ends early when the client hangs up, and after() runs even when
// the write failed. So ask Postgres what became of that transaction, and
// wait while it's still open.
async function committed(xid: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const [row] = await db()<{ status: string | null }[]>`
      SELECT pg_xact_status(${xid}::xid8) AS status`;
    if (row?.status === "committed") return true;
    if (row?.status !== "in progress") return false;
    await new Promise((r) => setTimeout(r, 25 + i * 10));
  }
  return false;
}

async function send(match: string, chosen: Mark[], xid: string): Promise<void> {
  try {
    // Only marks that committed: a write that rolled back wakes nobody.
    if (!(await committed(xid))) return;
    await Promise.all(
      chosen.map(async ({ player, nudges, until }) => {
        const outcome = await sendNudge(player, match);
        if (outcome === "sent") return;
        // Only the leave this nudge went on: a newer one, from a pass given
        // since, stays. Sent as text, since the driver would round the time
        // to milliseconds.
        if (outcome === "cant_wake")
          await db()`DELETE FROM wake_leave WHERE player = ${player} AND until = ${until}::text::timestamptz`;
        else {
          const pause = outcome === "limited" ? BACKOFF_MS : FAILED_PAUSE_MS;
          pausedUntil = Math.max(pausedUntil, now().getTime() + pause);
          logFailure(new Error(`nudge ${outcome}`), `nudge_${outcome}`, match);
        }
        // Not woken, so not waiting: the next event tries again.
        await db()`
          UPDATE match_reads SET waiting = false
          WHERE match_id = ${match} AND player = ${player}
            AND nudges = ${nudges} AND waiting`;
      }),
    );
  } catch (e) {
    logFailure(e, "nudge", match);
  }
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
