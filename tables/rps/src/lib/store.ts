import { randomBytes } from "node:crypto";
import { type Result, resultSchema } from "@unprompted-tables/game";
import {
  ApiError,
  db,
  isReadOnly,
  sweepLobby,
  type Tx,
} from "@unprompted-tables/server";
import { now, tableNow } from "./clock";
import {
  advance,
  apply,
  due,
  type MatchEvent,
  type MatchState,
  places,
  replay,
} from "./match";
import { GAME, LOBBY_LOCK, SETTINGS } from "./settings";

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
      VALUES (${id}, ${from + i}, ${e.kind}, ${tx.json(e)})`;
  const next = due(state);
  if (next)
    await tx`
      INSERT INTO open_matches (match_id, players, due)
      VALUES (${id}, ${state.players}, ${next})
      ON CONFLICT (match_id) DO UPDATE SET due = EXCLUDED.due`;
  else await tx`DELETE FROM open_matches WHERE match_id = ${id}`;
  const end = events.find((e) => e.kind === "end");
  const placed = end ? places(state) : null;
  if (end && placed) {
    const result: Result = resultSchema.parse({
      game: GAME,
      match: id,
      at: end.at,
      players: placed,
    });
    await tx`
      INSERT INTO results (match_id, result, at)
      VALUES (${id}, ${tx.json(result)}, ${end.at})`;
  }
}

function fold(state: MatchState, events: MatchEvent[]): MatchState {
  return events.reduce(apply, state);
}

// Runs fn on a match's state with its clock brought up to now, holding the
// match's row lock, and stores the events the clock and fn add. If fn
// refuses, nothing is stored: the clock's events follow from deadlines, so
// the next look at the match makes the same ones again. fn gets the time
// the request's transaction began (see tableNow), for the events it adds.
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

export type MatchView = {
  id: string;
  players: [string, string];
  round: number | null;
  phase: MatchState["phase"];
  due: string | null;
  wins: Record<string, number>;
  outcome: MatchState["outcome"];
  winner: string | null;
  events: MatchEvent[];
};

export function view(state: MatchState, events: MatchEvent[]): MatchView {
  const d = due(state);
  return {
    id: state.id,
    players: state.players,
    round: state.phase === "over" ? null : state.round,
    phase: state.phase,
    due: d ? d.toISOString() : null,
    wins: {
      [state.players[0]]: state.wins[0],
      [state.players[1]]: state.wins[1],
    },
    outcome: state.outcome,
    winner: state.winner === null ? null : state.players[state.winner],
    events,
  };
}

// A match as it stands now, read without its lock, so people watching don't
// hold up the players. Only when a phase has run out does reading take the
// lock and store the clock's events, and not when the Table is read-only:
// then the closed phases show but aren't stored.
export async function readMatch(id: string): Promise<MatchView> {
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
      value: view(state, events),
    }));
  const { stored, late } = seen;
  return view(fold(replay(id, stored), late), [...stored, ...late]);
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

export async function startMatch(
  tx: Tx,
  players: [string, string],
): Promise<string> {
  const id = newMatchId();
  const start: MatchEvent = {
    kind: "start",
    at: (await tableNow(tx)).toISOString(),
    players,
  };
  await tx`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
  await append(tx, id, 0, [start], replay(id, [start]));
  return id;
}

// Brings the clocks of matches whose time ran out while nobody looked up to
// date, most overdue first, a few at a time, so their results reach the
// standings.
export async function sweep(limit = 25): Promise<void> {
  if (isReadOnly()) return;
  const stale = await db().begin(
    async (tx) => tx<{ match_id: string }[]>`
      SELECT match_id FROM open_matches
      WHERE due <= ${await tableNow(tx)}
      ORDER BY due LIMIT ${limit}`,
  );
  for (const { match_id } of stale)
    await withMatch(match_id, async () => ({ events: [], value: undefined }));
  await db().begin(async (tx) =>
    sweepLobby(tx, LOBBY_LOCK, SETTINGS.lobby, await tableNow(tx)),
  );
  await db()`DELETE FROM sessions WHERE expires_at <= ${now()}`;
}

export async function allResults(): Promise<Result[]> {
  const rows = await db()<{ result: Result }[]>`SELECT result FROM results`;
  return rows.map((r) => r.result);
}

// Changes whenever a result is added, so a cache of the standings keyed on
// it is never stale.
export async function resultsVersion(): Promise<string> {
  const [row] = await db()<{ n: number; last: Date | null }[]>`
    SELECT count(*)::int AS n, max(at) AS last FROM results`;
  return `${row?.n ?? 0}:${row?.last?.toISOString() ?? ""}`;
}

export async function playersSince(): Promise<Map<string, Date>> {
  const rows = await db()<{ handle: string; on_site_since: Date }[]>`
    SELECT handle, on_site_since FROM players`;
  return new Map(rows.map((r) => [r.handle, r.on_site_since]));
}

export async function recentMatches(
  player: string | null,
  limit = 50,
): Promise<
  { id: string; players: string[]; created_at: Date; over: boolean }[]
> {
  return db()<
    { id: string; players: string[]; created_at: Date; over: boolean }[]
  >`
    SELECT m.id, m.players, m.created_at,
           NOT EXISTS (SELECT 1 FROM open_matches o WHERE o.match_id = m.id) AS over
    FROM matches m
    WHERE ${player === null} OR m.players @> ARRAY[${player ?? ""}]::text[]
    ORDER BY m.created_at DESC LIMIT ${limit}`;
}
