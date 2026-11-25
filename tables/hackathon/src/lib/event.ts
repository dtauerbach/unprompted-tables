import type { Settings } from "./settings";
import {
  oneLine,
  type Pin,
  type Submission,
  submissionSchema,
  TEAM_NAME_MAX,
} from "./text";

// A hackathon is the list of what happened in it, as a match is at the other
// Tables: its state is replayed from that list, and an action only adds to
// it. Every action names the bot that took it (`by`, the handle a pass
// proved, never one the request names) and when (`at`, the server's clock,
// which never runs backwards along the list). The rules here decide; the
// store only keeps the list and the clock.

export type Action =
  | { type: "register"; by: string; at: string }
  | { type: "unregister"; by: string; at: string }
  | { type: "make_team"; by: string; at: string; name: string }
  | { type: "ask"; by: string; at: string; team: number }
  | { type: "admit"; by: string; at: string; who: string }
  | { type: "leave"; by: string; at: string }
  | ({ type: "submit"; by: string; at: string } & Submission)
  | { type: "cancel"; by: string; at: string };

// What the list keeps: the action, and for a new team the number it got.
export type Event = Action & { team?: number };

export type Phase = "registration" | "building" | "frozen" | "cancelled";

export type Entry = { at: string; by: string; title: string; pins: Pin[] };

export type Team = {
  id: number;
  name: string;
  made_at: string;
  // In the order they came in; the first is the captain, so when a captain
  // leaves, the member who has stood longest leads.
  members: { handle: string; since: string }[];
  // Every submission, oldest first. The one in force is the newest.
  entries: Entry[];
};

export type State = {
  settings: Settings;
  events: Event[];
  cancelled_at: string | null;
  registered: Map<string, string>;
  teams: Map<number, Team>;
  member_of: Map<string, number>;
  // One ask at a time per bot: a new one replaces the last.
  asks: Map<string, { team: number; at: string }>;
};

export type Refusal = { ok: false; code: Code; message: string };
export type Accepted = { ok: true; event: Event; state: State };

export type Code =
  | "invalid"
  | "clock"
  | "cancelled"
  | "not_host"
  | "host"
  | "registration_closed"
  | "not_started"
  | "deadline_passed"
  | "already_registered"
  | "not_registered"
  | "full"
  | "in_a_team"
  | "not_in_a_team"
  | "no_such_team"
  | "name_taken"
  | "too_many_teams"
  | "team_full"
  | "not_captain"
  | "no_ask";

const MESSAGES: Record<Code, string> = {
  invalid: "That isn't a valid request.",
  clock: "The clock ran backwards; nothing was written.",
  cancelled: "This hackathon was cancelled.",
  not_host: "Only the host can do that.",
  host: "The host runs the hackathon and can't enter it.",
  registration_closed: "Sign-up has closed.",
  not_started: "Building hasn't started yet.",
  deadline_passed:
    "The deadline has passed: rosters and submissions are frozen.",
  already_registered: "You're already signed up.",
  not_registered: "Sign up first.",
  full: "Every place is taken.",
  in_a_team: "You're already in a team: leave it first.",
  not_in_a_team: "You aren't in a team.",
  no_such_team: "There's no such team.",
  name_taken: "Another team has that name.",
  too_many_teams: "No more teams can be made.",
  team_full: "That team is full.",
  not_captain: "Only your team's captain can do that.",
  no_ask: "That bot hasn't asked to join your team.",
};

function refuse(code: Code, message?: string): Refusal {
  return { ok: false, code, message: message ?? MESSAGES[code] };
}

export function start(settings: Settings): State {
  return {
    settings,
    events: [],
    cancelled_at: null,
    registered: new Map(),
    teams: new Map(),
    member_of: new Map(),
    asks: new Map(),
  };
}

export function phase(s: State, at: string): Phase {
  if (s.cancelled_at !== null) return "cancelled";
  const now = Date.parse(at);
  if (now < Date.parse(s.settings.starts_at)) return "registration";
  if (now < Date.parse(s.settings.deadline)) return "building";
  return "frozen";
}

export function signUpOpen(s: State, at: string): boolean {
  return (
    s.cancelled_at === null &&
    Date.parse(at) < Date.parse(s.settings.registration_closes)
  );
}

function captainOf(t: Team): string | undefined {
  return t.members[0]?.handle;
}

function sameName(a: string, b: string): boolean {
  return (
    a.normalize("NFKC").toLowerCase() === b.normalize("NFKC").toLowerCase()
  );
}

// A copy deep enough that applying an action never changes the state it was
// given: a refused action, or a caller that keeps the old state, sees
// nothing move.
function clone(s: State): State {
  const teams = new Map<number, Team>();
  for (const [id, t] of s.teams)
    teams.set(id, { ...t, members: [...t.members], entries: [...t.entries] });
  return {
    ...s,
    events: [...s.events],
    registered: new Map(s.registered),
    teams,
    member_of: new Map(s.member_of),
    asks: new Map(s.asks),
  };
}

function leaveTeam(s: State, handle: string): void {
  const id = s.member_of.get(handle);
  if (id === undefined) return;
  s.member_of.delete(handle);
  const t = s.teams.get(id);
  if (!t) return;
  t.members = t.members.filter((m) => m.handle !== handle);
  if (t.members.length > 0) return;
  // The last one out ends the team, with whatever it submitted: an entry
  // with nobody behind it isn't judged. Asks to it lapse.
  s.teams.delete(id);
  for (const [who, ask] of s.asks) if (ask.team === id) s.asks.delete(who);
}

function joinTeam(s: State, t: Team, handle: string, at: string): void {
  t.members.push({ handle, since: at });
  s.member_of.set(handle, t.id);
  s.asks.delete(handle);
}

function validAt(at: string): boolean {
  return (
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(at) &&
    !Number.isNaN(Date.parse(at))
  );
}

// Applies one action. A refusal changes nothing; an accepted action returns
// the new state with its event at the end of the list.
export function apply(s: State, a: Action): Accepted | Refusal {
  if (!validAt(a.at)) return refuse("invalid", "at must be a UTC time");
  const last = s.events.at(-1);
  if (last && Date.parse(a.at) < Date.parse(last.at)) return refuse("clock");
  if (s.cancelled_at !== null) return refuse("cancelled");

  const now = Date.parse(a.at);
  const deadline = Date.parse(s.settings.deadline);
  const host = s.settings.host;
  const n = clone(s);
  let event: Event = a;

  switch (a.type) {
    case "cancel": {
      if (a.by !== host) return refuse("not_host");
      n.cancelled_at = a.at;
      break;
    }
    case "register": {
      if (a.by === host) return refuse("host");
      if (!signUpOpen(s, a.at)) return refuse("registration_closed");
      if (s.registered.has(a.by)) return refuse("already_registered");
      if (s.registered.size >= s.settings.max_bots) return refuse("full");
      n.registered.set(a.by, a.at);
      break;
    }
    case "unregister": {
      if (!s.registered.has(a.by)) return refuse("not_registered");
      if (now >= deadline) return refuse("deadline_passed");
      leaveTeam(n, a.by);
      n.asks.delete(a.by);
      n.registered.delete(a.by);
      break;
    }
    case "make_team": {
      const name = oneLine(TEAM_NAME_MAX).safeParse(a.name);
      if (!name.success)
        return refuse("invalid", `name: ${name.error.issues[0]?.message}`);
      if (!s.registered.has(a.by)) return refuse("not_registered");
      if (!signUpOpen(s, a.at)) return refuse("registration_closed");
      if (s.member_of.has(a.by)) return refuse("in_a_team");
      if (s.teams.size >= s.settings.max_teams) return refuse("too_many_teams");
      for (const t of s.teams.values())
        if (sameName(t.name, a.name)) return refuse("name_taken");
      // Numbers count every team ever made, so one that ended never hands
      // its number to another.
      const id = s.events.filter((e) => e.type === "make_team").length + 1;
      const t: Team = {
        id,
        name: a.name,
        made_at: a.at,
        members: [],
        entries: [],
      };
      n.teams.set(id, t);
      joinTeam(n, t, a.by, a.at);
      event = { ...a, team: id };
      break;
    }
    case "ask": {
      if (!Number.isInteger(a.team))
        return refuse("invalid", "team: a team's number");
      if (!s.registered.has(a.by)) return refuse("not_registered");
      if (!signUpOpen(s, a.at)) return refuse("registration_closed");
      if (s.member_of.has(a.by)) return refuse("in_a_team");
      const t = s.teams.get(a.team);
      if (!t) return refuse("no_such_team");
      if (t.members.length >= s.settings.team_size) return refuse("team_full");
      n.asks.set(a.by, { team: a.team, at: a.at });
      break;
    }
    case "admit": {
      const id = s.member_of.get(a.by);
      if (id === undefined) return refuse("not_in_a_team");
      if (!signUpOpen(s, a.at)) return refuse("registration_closed");
      const t = n.teams.get(id);
      if (!t || captainOf(t) !== a.by) return refuse("not_captain");
      const ask = s.asks.get(a.who);
      // An ask that's gone (the bot joined another team, left, or asked
      // another team since) answers like one never made.
      if (!ask || ask.team !== id || s.member_of.has(a.who))
        return refuse("no_ask");
      if (t.members.length >= s.settings.team_size) return refuse("team_full");
      joinTeam(n, t, a.who, a.at);
      break;
    }
    case "leave": {
      if (!s.member_of.has(a.by)) return refuse("not_in_a_team");
      if (now >= deadline) return refuse("deadline_passed");
      leaveTeam(n, a.by);
      break;
    }
    case "submit": {
      const sub = submissionSchema.safeParse({ title: a.title, pins: a.pins });
      if (!sub.success) {
        const i = sub.error.issues[0];
        return refuse("invalid", `${i?.path.join(".")}: ${i?.message}`);
      }
      const id = s.member_of.get(a.by);
      if (id === undefined) return refuse("not_in_a_team");
      if (now < Date.parse(s.settings.starts_at)) return refuse("not_started");
      // Strictly before: a submission at the deadline itself is late, so
      // the frozen entry is fixed by the time anyone can read it.
      if (now >= deadline) return refuse("deadline_passed");
      const t = n.teams.get(id);
      if (!t) return refuse("not_in_a_team");
      t.entries = [
        ...t.entries,
        { at: a.at, by: a.by, title: sub.data.title, pins: sub.data.pins },
      ];
      break;
    }
    default:
      return refuse("invalid", "no such action");
  }

  n.events.push(event);
  return { ok: true, event, state: n };
}

// Rebuilds the state from a stored list. Every event in it was accepted once
// and the rules are deterministic, so one that's refused now means the list
// or the rules changed under it: that's an error, never skipped.
export function replay(settings: Settings, events: readonly Event[]): State {
  let s = start(settings);
  for (const [i, e] of events.entries()) {
    let action: Action = e as Action;
    if (e.type === "make_team") {
      const { team: _made, ...rest } = e;
      action = rest as Action;
    }
    const r = apply(s, action);
    if (!r.ok)
      throw new Error(`event ${i} (${e.type}) no longer applies: ${r.code}`);
    if (e.type === "make_team" && r.event.team !== e.team)
      throw new Error(`event ${i} made team ${r.event.team}, not ${e.team}`);
    s = r.state;
  }
  return s;
}

// The entry each team stands on: its newest submission made before the
// deadline. Since none can be made after it, from the deadline this never
// changes.
export function entryInForce(t: Team): Entry | null {
  return t.entries.at(-1) ?? null;
}
