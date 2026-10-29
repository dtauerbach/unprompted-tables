import { randomBytes } from "node:crypto";
import { sideResultSchema } from "@unprompted-tables/game";
import { ApiError, db, isReadOnly, type Tx } from "@unprompted-tables/server";
import { tableNow } from "./clock";
import {
  advance,
  apply,
  due,
  type MatchEvent,
  type MatchState,
  replay,
  start,
  view,
} from "./match";
import { SETTINGS } from "./settings";

// Matches in the database: their events, their results, and which are still
// open. The rules of a match are in match.ts; this file runs each match's
// clock and stores what the rules decide.

const MATCH_ID_RE = /^m_[A-Za-z0-9_-]{12}$/;

export function newMatchId(): string {
  return `m_${randomBytes(9).toString("base64url")}`;
}

async function loadEvents(tx: Tx, id: string): Promise<MatchEvent[]> {
  const rows = await tx<{ body: MatchEvent }[]>`
    SELECT body FROM events WHERE match_id = ${id} ORDER BY seq`;
  return rows.map((r) => r.body);
}

async function append(
  tx: Tx,
  id: string,
  from: number,
  events: MatchEvent[],
  state: MatchState,
): Promise<void> {
  if (events.length === 0) return;
  for (const [i, e] of events.entries())
    await tx`
      INSERT INTO events (match_id, seq, kind, body)
      VALUES (${id}, ${from + i}, ${e.body.kind}, ${tx.json(e)})`;
  const next = due(state);
  // Liveness is a rule decision, not the presence of a scheduled deadline.
  if (state.phase !== "over")
    await tx`
      INSERT INTO open_matches (match_id, players, due)
      VALUES (${id}, ${state.players}, ${next})
      ON CONFLICT (match_id) DO UPDATE SET due = EXCLUDED.due`;
  else await tx`DELETE FROM open_matches WHERE match_id = ${id}`;
  const end = events.find((e) => e.body.kind === "end");
  if (end && state.result) {
    const result = sideResultSchema.parse(state.result);
    await tx`INSERT INTO results (match_id, result, at)
      VALUES (${id}, ${tx.json(result)}, ${result.at})`;
  }
}

function fold(state: MatchState, events: MatchEvent[]): MatchState {
  return events.reduce(apply, state);
}

// Runs fn on a match's state with its clock brought up to now, holding the
// match's row lock, and stores the events the clock and fn add. If fn
// refuses, nothing is stored: the clock's events follow from deadlines, so
// the next look at the match makes the same ones again. fn gets the time
// after acquiring the row lock (see tableNow), for the events it adds.
export async function withMatch<T>(
  id: string,
  fn: (
    state: MatchState,
    events: MatchEvent[],
    tx: Tx,
    at: Date,
  ) => Promise<{ events: MatchEvent[]; value: T }>,
): Promise<T> {
  if (!MATCH_ID_RE.test(id)) throw noSuchMatch(id);
  const value = await db().begin(async (tx) => {
    const [row] = await tx`SELECT id FROM matches WHERE id = ${id} FOR UPDATE`;
    if (!row) throw noSuchMatch(id);
    const at = await tableNow(tx);
    const stored = await loadEvents(tx, id);
    const late = advance(replay(id, stored), at);
    const state = fold(replay(id, stored), late);
    const out = await fn(state, [...stored, ...late], tx, at);
    const added = [...late, ...out.events];
    await append(tx, id, stored.length, added, fold(state, out.events));
    return out.value;
  });
  return value as T;
}

// A match as it stands now, read without its lock, so people watching don't
// hold up the players. Only when a phase has run out does reading take the
// lock and store the clock's events, and not when the Table is read-only:
// then the closed phases show but aren't stored.
export async function readMatch(id: string, player: string | null) {
  if (!MATCH_ID_RE.test(id)) throw noSuchMatch(id);
  const seen = await db().begin(async (tx) => {
    const [row] = await tx`SELECT id FROM matches WHERE id = ${id}`;
    if (!row) throw noSuchMatch(id);
    const stored = await loadEvents(tx, id);
    const late = advance(replay(id, stored), await tableNow(tx));
    return { stored, late };
  });
  if (seen.late.length > 0 && !isReadOnly())
    return withMatch(id, async (state, events) => ({
      events: [],
      value: view(state, events, player),
    }));
  const { stored, late } = seen;
  return view(fold(replay(id, stored), late), [...stored, ...late], player);
}

function noSuchMatch(id: string): ApiError {
  return new ApiError(
    404,
    "no_such_match",
    `There is no match ${id.slice(0, 40)}.`,
  );
}

export async function openMatchOf(
  tx: Tx,
  player: string,
): Promise<string | null> {
  const [row] = await tx<{ match_id: string }[]>`
    SELECT match_id FROM open_matches
    WHERE players @> ARRAY[${player}]::text[]
    ORDER BY due LIMIT 1`;
  return row?.match_id ?? null;
}

export async function startMatch(tx: Tx, players: string[]): Promise<string> {
  const id = newMatchId();
  const {
    players: _players,
    reveal_on_death,
    talk_seconds,
    vote_seconds,
    max_days,
  } = SETTINGS;
  const events = start(
    players,
    {
      players: players.length,
      reveal_on_death,
      talk_seconds,
      vote_seconds,
      max_days,
    },
    await tableNow(tx),
  );
  await tx`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
  await append(tx, id, 0, events, replay(id, events));
  return id;
}
