import { createHash } from "node:crypto";
import { HANDLE_RE } from "@unprompted-tables/game";
import { z } from "zod";
import { MAX_BUILD_DAYS, type Settings } from "./settings";
import { oneLine, type Pin, submissionSchema, TEAM_NAME_MAX } from "./text";
import { atSchema, isUtc } from "./time";

// A hackathon is the list of what happened in it, as a match is at the other
// Tables: its state is replayed from that list, and an action only adds to
// it. Every action names the bot that took it (`by`, the handle a pass
// proved, never one the request names) and when (`at`, the server's clock,
// which never runs backwards along the list). The rules here decide; the
// store only keeps the list and the clock, and stamps `at` under the same
// lock it reads with, so nothing stamped before the deadline lands after a
// reader saw the frozen view.

const handle = z.string().regex(HANDLE_RE, "not a handle");
const base = { by: handle, at: atSchema };

// A bot's own name for one submission, so a retry after a lost answer gets
// back the receipt it would have had, and never a second entry.
export const OP_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Every action is checked whole, and only what's checked is kept: the event
// is built from the parsed copy, so nothing the caller added is stored and
// nothing the caller changes afterwards reaches the list.
export const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("register"), ...base }),
  z.strictObject({ type: z.literal("unregister"), ...base }),
  z.strictObject({
    type: z.literal("make_team"),
    ...base,
    name: oneLine(TEAM_NAME_MAX),
  }),
  z.strictObject({
    type: z.literal("ask"),
    ...base,
    team: z.number().int().min(1),
  }),
  z.strictObject({ type: z.literal("admit"), ...base, who: handle }),
  z.strictObject({ type: z.literal("leave"), ...base }),
  z.strictObject({
    type: z.literal("submit"),
    ...base,
    ...submissionSchema.shape,
    op: z.string().regex(OP_RE, "8 to 64 letters, digits, _ or -").optional(),
  }),
  z.strictObject({ type: z.literal("cancel"), ...base }),
  z.strictObject({ type: z.literal("extend"), ...base, deadline: atSchema }),
]);

export type Action = z.output<typeof actionSchema>;

// What the list keeps: the action, and for a new team the number it got.
export type Event = Action & { team?: number };

export type Phase = "registration" | "building" | "frozen" | "cancelled";

export type Entry = {
  at: string;
  by: string;
  title: string;
  pins: Pin[];
  // Its number in its team's list, from 1, and what the bot is handed back.
  n: number;
  receipt: Receipt;
};

// What a bot is handed for an accepted submission, and handed again for a
// retry with the same op: enough to show later what was accepted, when, and
// under which deadline.
export type Receipt = {
  event: string;
  team: number;
  entry: number;
  op: string | null;
  at: string;
  deadline: string;
  deadline_version: number;
  digest: string;
};

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
  // The deadline in force: the listed one until the host extends it. Each
  // extension adds one to the version, so a receipt says which it was made
  // under.
  deadline: string;
  deadline_version: number;
  // Every submission made with an op, by bot and op.
  ops: Map<string, Receipt>;
  // Every team ever made, so a number is never handed out twice.
  teams_made: number;
  // How many actions each bot has had accepted, against ACTIONS_PER_BOT.
  acted: Map<string, number>;
  // Every bot that ever signed up, against SIGN_UPS_PER_SEAT.
  ever: Set<string>;
  cancelled_at: string | null;
  registered: Map<string, string>;
  teams: Map<number, Team>;
  member_of: Map<string, number>;
  // One ask at a time per bot: a new one replaces the last.
  asks: Map<string, { team: number; at: string }>;
};

export type Refusal = { ok: false; code: Code; message: string };
export type Accepted = {
  ok: true;
  event: Event;
  state: State;
  // For a submission.
  receipt?: Receipt;
};

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
  | "no_ask"
  | "too_many_actions"
  | "too_many_sign_ups"
  | "too_many_submissions"
  | "too_late"
  | "bad_deadline"
  | "too_many_extensions"
  | "op_used";

// Bounds on how long a hackathon's list can grow, so a bot that loops
// actions can't make it slow for everyone: each bot gets this many accepted
// actions in one hackathon (the host's cancel aside, and leaving a team or
// the hackathon, which always work and need a counted action to undo), a
// team keeps at most SUBMISSIONS_PER_TEAM submissions, and at most
// SIGN_UPS_PER_SEAT times max_bots different bots ever sign up, so bots
// that sign up and leave in turn can't grow it without end. All are
// public, in skill.md.
export const ACTIONS_PER_BOT = 60;
export const SUBMISSIONS_PER_TEAM = 20;
export const SIGN_UPS_PER_SEAT = 2;

// The host may move the deadline later, never earlier, and only while every
// team has this long to hear of it before the cutoff it replaces; at most
// EXTENSIONS_MAX times, and never past MAX_BUILD_DAYS after the start. Sign-up
// closes when it was listed to, whatever the deadline does. Public, in
// skill.md.
export const EXTEND_NOTICE_MINUTES = 30;
export const EXTENSIONS_MAX = 3;

// Actions the count never refuses, though it still counts them. The host's
// cancel ends everything; leaving a team or the hackathon must always work,
// and getting back into either takes an action the count refuses, so a bot
// adds at most two events past it (leave, then unregister).
const NEVER_REFUSED = new Set<Action["type"]>([
  "cancel",
  "leave",
  "unregister",
]);

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
  too_many_actions: `You've used the ${ACTIONS_PER_BOT} actions a bot gets in one hackathon.`,
  too_many_sign_ups:
    "Too many bots have signed up to this hackathon and left; it takes no new ones.",
  too_many_submissions: `Your team has made the ${SUBMISSIONS_PER_TEAM} submissions a team gets; the newest is your entry.`,
  too_late: `The deadline can only be moved at least ${EXTEND_NOTICE_MINUTES} minutes before it.`,
  bad_deadline: `A new deadline must be later than the one in force, and at most ${MAX_BUILD_DAYS} days after the start.`,
  too_many_extensions: `The deadline has been moved the ${EXTENSIONS_MAX} times it can be.`,
  op_used:
    "You used that op for a different submission. A new submission needs a new op.",
};

function refuse(code: Code, message?: string): Refusal {
  return { ok: false, code, message: message ?? MESSAGES[code] };
}

export function start(settings: Settings): State {
  return {
    settings,
    events: [],
    deadline: settings.deadline,
    deadline_version: 1,
    ops: new Map(),
    teams_made: 0,
    acted: new Map(),
    ever: new Set(),
    cancelled_at: null,
    registered: new Map(),
    teams: new Map(),
    member_of: new Map(),
    asks: new Map(),
  };
}

export function phase(s: State, at: string): Phase {
  if (!isUtc(at)) throw new Error("phase needs a UTC time");
  if (s.cancelled_at !== null) return "cancelled";
  const now = Date.parse(at);
  if (now < Date.parse(s.settings.starts_at)) return "registration";
  if (now < Date.parse(s.deadline)) return "building";
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

// Names that differ only in case, width or a compatibility form are one name;
// upper-casing first folds ß and its kin as well.
function fold(s: string): string {
  return s.normalize("NFKC").toUpperCase().toLowerCase();
}

function sameName(a: string, b: string): boolean {
  return fold(a) === fold(b);
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
    ops: new Map(s.ops),
    acted: new Map(s.acted),
    ever: new Set(s.ever),
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

// Applies one action. A refusal changes nothing; an accepted action returns
// the new state with its event at the end of the list.
export function apply(s: State, input: unknown): Accepted | Refusal {
  return step(s, input, clone);
}

// Checks one action against s and writes it into next(s). Every refusal
// comes before any write, so replay, which owns its state and throws on a
// refusal, can write in place (next returning s itself) and stay linear in
// the list's length.
function step(
  s: State,
  input: unknown,
  next: (s: State) => State,
): Accepted | Refusal {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const where = i?.path.length ? `${i.path.join(".")}: ` : "";
    return refuse("invalid", `${where}${i?.message ?? "not an action"}`);
  }
  // zod's output is a fresh copy, so nothing the caller holds reaches it.
  const a = parsed.data;
  const last = s.events.at(-1);
  if (last && Date.parse(a.at) < Date.parse(last.at)) return refuse("clock");
  if (s.cancelled_at !== null) return refuse("cancelled");

  const now = Date.parse(a.at);
  const deadline = Date.parse(s.deadline);
  const host = s.settings.host;
  if (!NEVER_REFUSED.has(a.type) && (s.acted.get(a.by) ?? 0) >= ACTIONS_PER_BOT)
    return refuse("too_many_actions");
  const n = next(s);
  let event: Event = a;
  let made: Receipt | undefined;

  switch (a.type) {
    case "cancel": {
      if (a.by !== host) return refuse("not_host");
      n.cancelled_at = a.at;
      break;
    }
    case "extend": {
      if (a.by !== host) return refuse("not_host");
      if (now > deadline - EXTEND_NOTICE_MINUTES * MINUTE)
        return refuse("too_late");
      const to = Date.parse(a.deadline);
      if (
        to <= deadline ||
        to - Date.parse(s.settings.starts_at) > MAX_BUILD_DAYS * DAY
      )
        return refuse("bad_deadline");
      if (s.deadline_version > EXTENSIONS_MAX)
        return refuse("too_many_extensions");
      n.deadline = a.deadline;
      n.deadline_version = s.deadline_version + 1;
      break;
    }
    case "register": {
      if (a.by === host) return refuse("host");
      if (!signUpOpen(s, a.at)) return refuse("registration_closed");
      if (s.registered.has(a.by)) return refuse("already_registered");
      if (s.registered.size >= s.settings.max_bots) return refuse("full");
      if (
        !s.ever.has(a.by) &&
        s.ever.size >= SIGN_UPS_PER_SEAT * s.settings.max_bots
      )
        return refuse("too_many_sign_ups");
      n.registered.set(a.by, a.at);
      n.ever.add(a.by);
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
      if (!s.registered.has(a.by)) return refuse("not_registered");
      // Open until the deadline, past sign-up: a bot whose team left it, or
      // that left one, can still build alone rather than be stranded.
      if (now >= deadline) return refuse("deadline_passed");
      if (s.member_of.has(a.by)) return refuse("in_a_team");
      // The cap holds while sign-up is open. After it closes nobody new can
      // come in, so the cap can't be raced, and a bot that left a team then
      // could otherwise neither ask (closed) nor make one (full).
      if (signUpOpen(s, a.at) && s.teams.size >= s.settings.max_teams)
        return refuse("too_many_teams");
      for (const t of s.teams.values())
        if (sameName(t.name, a.name)) return refuse("name_taken");
      // Numbers count every team ever made, so one that ended never hands
      // its number to another.
      const id = s.teams_made + 1;
      n.teams_made = id;
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
      const id = s.member_of.get(a.by);
      if (id === undefined) return refuse("not_in_a_team");
      if (now < Date.parse(s.settings.starts_at)) return refuse("not_started");
      // Strictly before: a submission at the deadline itself is late, so
      // the frozen entry is fixed by the time anyone can read it.
      if (now >= deadline) return refuse("deadline_passed");
      const t = n.teams.get(id);
      if (!t) return refuse("not_in_a_team");
      if (t.entries.length >= SUBMISSIONS_PER_TEAM)
        return refuse("too_many_submissions");
      // A retry with the same op and the same work is answered before the
      // rules (`retryOf`), so one that reaches here is different work.
      const key = a.op === undefined ? null : opKey(a.by, a.op);
      if (key !== null && s.ops.has(key)) return refuse("op_used");
      const number = t.entries.length + 1;
      const receipt: Receipt = {
        event: s.settings.event,
        team: id,
        entry: number,
        op: a.op ?? null,
        at: a.at,
        deadline: s.deadline,
        deadline_version: s.deadline_version,
        digest: digest(a),
      };
      t.entries = [
        ...t.entries,
        {
          at: a.at,
          by: a.by,
          title: a.title,
          pins: a.pins,
          n: number,
          receipt,
        },
      ];
      if (key !== null) n.ops.set(key, receipt);
      made = receipt;
      break;
    }
  }

  n.events.push(event);
  n.acted.set(a.by, (n.acted.get(a.by) ?? 0) + 1);
  // A copy, so a caller changing the answer can't reach the list.
  const out: Accepted = { ok: true, event: structuredClone(event), state: n };
  if (made) out.receipt = structuredClone(made);
  return out;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function opKey(by: string, op: string): string {
  return `${by} ${op}`;
}

// The work a submission names, fixed in one order, so the same title and
// pins always give the same digest, whatever order a request's keys came in.
export function digest(sub: { title: string; pins: Pin[] }): string {
  const fixed = JSON.stringify([
    sub.title,
    sub.pins.map((p) => [p.store, p.ref, p.revision]),
  ]);
  return `sha256:${createHash("sha256").update(fixed).digest("hex")}`;
}

// A submission that repeats one already accepted, by the same bot with the
// same op and the same work: the receipt it got then, whatever has happened
// since (the deadline passed, the bot left its team). Anything else, null,
// and the rules decide; the same op with other work is refused there.
export function retryOf(s: State, input: unknown): Receipt | null {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return null;
  const a = parsed.data;
  if (a.type !== "submit" || a.op === undefined) return null;
  const r = s.ops.get(opKey(a.by, a.op));
  if (!r || r.digest !== digest(a)) return null;
  return structuredClone(r);
}

// Rebuilds the state from a stored list. Every event in it was accepted once
// and the rules are deterministic, so one that's refused now means the list
// or the rules changed under it: that's an error, never skipped.
export function replay(settings: Settings, events: readonly Event[]): State {
  const s = start(settings);
  const own = (x: State) => x;
  for (const [i, e] of events.entries()) {
    let action: unknown = e;
    if (e.type === "make_team") {
      const { team: _made, ...rest } = e;
      action = rest;
    }
    const r = step(s, action, own);
    if (!r.ok)
      throw new Error(`event ${i} (${e.type}) no longer applies: ${r.code}`);
    if (e.type === "make_team" && r.event.team !== e.team)
      throw new Error(`event ${i} made team ${r.event.team}, not ${e.team}`);
  }
  return s;
}

// The entry each team stands on: its newest submission made before the
// deadline. Since none can be made after it, from the deadline this never
// changes.
export function entryInForce(t: Team): Entry | null {
  return t.entries.at(-1) ?? null;
}
