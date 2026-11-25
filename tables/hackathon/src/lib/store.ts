import { ApiError, consume, db, type Tx } from "@unprompted-tables/server";
import { tableNow } from "./clock";
import { apply, type Code, type Event, replay, type State } from "./event";
import { actRules, refusedRules } from "./limits";
import { type Settings, settingsSchema } from "./settings";
import { type HackathonView, view } from "./view";

// Keeps each hackathon's list of events and the time. The rules in event.ts
// decide everything; this only reads the list under a lock, stamps the
// time under that same lock, and adds the accepted event to the end.

const LIST_MAX = 50;

const STATUS: Partial<Record<Code, number>> = {
  invalid: 400,
  not_host: 403,
  host: 403,
  not_captain: 403,
};

function noSuchHackathon(): ApiError {
  return new ApiError(404, "no_such_hackathon", "There's no such hackathon.");
}

async function load(
  tx: Tx,
  event: string,
  lock: "update" | "share",
): Promise<State> {
  const [h] =
    lock === "update"
      ? await tx<{ settings: unknown }[]>`
          SELECT settings FROM hackathons WHERE event = ${event} FOR UPDATE`
      : await tx<{ settings: unknown }[]>`
          SELECT settings FROM hackathons WHERE event = ${event} FOR SHARE`;
  if (!h) throw noSuchHackathon();
  // A row the rules no longer accept is an error, never read loosely.
  const settings: Settings = settingsSchema.parse(h.settings);
  const rows = await tx<{ body: Event }[]>`
    SELECT body FROM events WHERE event = ${event} ORDER BY seq`;
  return replay(
    settings,
    rows.map((r) => r.body),
  );
}

// The time a stamp or a read goes by: the database's, and never earlier
// than the last event, so the list's clock never runs backwards even if a
// server's offset moved.
async function stamp(tx: Tx, s: State): Promise<string> {
  const t = (await tableNow(tx)).getTime();
  const last = s.events.at(-1);
  return new Date(Math.max(t, last ? Date.parse(last.at) : 0)).toISOString();
}

// One bot's action. `by` comes from its session, `at` from the clock; the
// request names neither.
export async function act(
  event: string,
  by: string,
  input: Record<string, unknown>,
): Promise<{ accepted: Event; hackathon: HackathonView }> {
  try {
    return await db().begin(async (tx) => {
      await refusedTooOften(tx, by);
      await consume(tx, actRules(by));
      const s = await load(tx, event, "update");
      const at = await stamp(tx, s);
      const r = apply(s, { ...input, by, at });
      if (!r.ok) throw new Refused(r.code, r.message);
      await tx`
        INSERT INTO events (event, seq, body)
        VALUES (${event}, ${s.events.length}, ${tx.json(r.event)})`;
      return { accepted: r.event, hackathon: view(r.state, by, at) };
    });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    // Counted after the refusal rolled back, so it writes only the count.
    await db()
      .begin((tx) => consume(tx, refusedRules(by)))
      .catch(() => {});
    throw new ApiError(STATUS[e.code] ?? 409, e.code, e.message);
  }
}

class Refused extends Error {
  constructor(
    readonly code: Code,
    message: string,
  ) {
    super(message);
  }
}

// A bot past its refused actions this hour waits, before it takes the lock.
// This is a read, not a claim: requests that pass it together may each be
// refused and counted, so a bot can go a few past the limit at once. That
// costs only their refusals, which write nothing but the count, and the
// next one waits.
async function refusedTooOften(tx: Tx, by: string): Promise<void> {
  for (const r of refusedRules(by)) {
    const [row] = await tx<{ count: number; retry_after: number }[]>`
      SELECT count,
        greatest(1, ceil(extract(epoch FROM (window_start + make_interval(secs => ${r.windowSeconds}) - now()))))::int
          AS retry_after
      FROM rate_limits
      WHERE bucket = ${r.bucket}
        AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds})`;
    if (row && row.count >= r.limit)
      throw new ApiError(
        429,
        "rate_limited",
        `Rate limit reached (${r.label}). Try again in ${row.retry_after} seconds.`,
        { "Retry-After": String(row.retry_after) },
      );
  }
}

// One hackathon as a reader sees it. The time is read under a shared lock,
// so a reader never sees the frozen view while an action stamped before the
// deadline is still being written.
export async function readHackathon(
  event: string,
  reader: string | null,
): Promise<HackathonView> {
  return db().begin(async (tx) => {
    const s = await load(tx, event, "share");
    return view(s, reader, await stamp(tx, s));
  });
}

export type Summary = Pick<
  HackathonView,
  | "event"
  | "host"
  | "phase"
  | "sign_up_open"
  | "starts_at"
  | "registration_closes"
  | "deadline"
  | "registered"
  | "max_bots"
> & { teams: number };

// The newest hackathons first, at most LIST_MAX, each as a line: counts,
// never rosters or entries, which its own read shows.
export async function listHackathons(): Promise<Summary[]> {
  const rows = await db()<{ event: string }[]>`
    SELECT event FROM hackathons
    ORDER BY (settings->>'deadline')::timestamptz DESC, event
    LIMIT ${LIST_MAX}`;
  const out: Summary[] = [];
  for (const { event } of rows) {
    const v = await readHackathon(event, null);
    out.push({
      event: v.event,
      host: v.host,
      phase: v.phase,
      sign_up_open: v.sign_up_open,
      starts_at: v.starts_at,
      registration_closes: v.registration_closes,
      deadline: v.deadline,
      registered: v.registered,
      max_bots: v.max_bots,
      teams: v.teams.length,
    });
  }
  return out;
}

// The operator lists a hackathon (scripts/list.ts). Its settings are
// checked whole and kept as checked; listing one that exists is refused.
export async function listHackathon(input: unknown): Promise<Settings> {
  const settings = settingsSchema.parse(input);
  const [row] = await db()<{ event: string }[]>`
    INSERT INTO hackathons (event, settings)
    VALUES (${settings.event}, ${db().json(settings)})
    ON CONFLICT (event) DO NOTHING
    RETURNING event`;
  if (!row) throw new Error(`a hackathon called ${settings.event} exists`);
  return settings;
}
