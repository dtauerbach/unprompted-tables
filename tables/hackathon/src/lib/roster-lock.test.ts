import { describe, expect, it } from "vitest";
import {
  ACTIONS_PER_BOT,
  type Action,
  apply,
  type Refusal,
  retryOf,
  rosterLocks,
  rosterOpen,
  type State,
  SUBMISSIONS_PER_TEAM,
  start,
} from "./event";
import {
  ROSTER_LOCK_MINUTES,
  type Settings,
  settingsSchema,
  withRosterLock,
} from "./settings";
import { view } from "./view";

// H2b: rosters lock at a time of their own, before the deadline, and moving
// the deadline never moves it. Submitting still works until the deadline.

const LISTED = {
  event: "jam-1",
  host: "host-bot",
  starts_at: "2026-12-01T18:00:00Z",
  registration_closes: "2026-12-01T18:30:00Z",
  deadline: "2026-12-01T21:00:00Z",
  max_teams: 3,
  team_size: 2,
  max_bots: 6,
};
const SETTINGS: Settings = settingsSchema.parse(withRosterLock(LISTED));

const BEFORE = "2026-12-01T17:00:00Z";
const STARTED = "2026-12-01T18:10:00Z";
const BUILDING = "2026-12-01T19:00:00Z";
const LOCKS = "2026-12-01T20:00:00Z";
const LOCKED = "2026-12-01T20:30:00Z";
const DEADLINE = "2026-12-01T21:00:00Z";
const LATER = "2026-12-01T23:00:00Z";
const PIN = { store: "github", ref: "acme/jam", revision: "a1b2c3d" };

function ok(s: State, a: Action): State {
  const r = apply(s, a);
  if (!r.ok) throw new Error(`${a.type} by ${a.by} refused: ${r.code}`);
  return r.state;
}

function code(s: State, a: Action): string {
  const r = apply(s, a);
  expect(r.ok).toBe(false);
  return (r as Refusal).code;
}

// Owls (ann, bob), and eve registered in no team.
function withTeam(settings: Settings = SETTINGS): State {
  let s = start(settings);
  s = ok(s, { type: "register", by: "ann", at: BEFORE });
  s = ok(s, { type: "register", by: "bob", at: BEFORE });
  s = ok(s, { type: "register", by: "eve", at: BEFORE });
  s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
  s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
  s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
  return s;
}

describe("the roster lock's default", () => {
  it("fills in an hour before the deadline when the listing leaves it out", () => {
    expect(ROSTER_LOCK_MINUTES).toBe(60);
    expect(SETTINGS.roster_locks).toBe(LOCKS);
  });

  it("never locks before sign-up closes", () => {
    const late = { ...LISTED, registration_closes: "2026-12-01T20:45:00Z" };
    expect(settingsSchema.parse(withRosterLock(late)).roster_locks).toBe(
      "2026-12-01T20:45:00Z",
    );
  });

  it("keeps a lock the listing sets", () => {
    const set = { ...LISTED, roster_locks: "2026-12-01T19:30:00Z" };
    expect(settingsSchema.parse(withRosterLock(set)).roster_locks).toBe(
      "2026-12-01T19:30:00Z",
    );
  });

  it("spells a lock the listing sets as whole seconds", () => {
    const set = { ...LISTED, roster_locks: "2026-12-01T19:30:00.000Z" };
    expect(settingsSchema.parse(withRosterLock(set)).roster_locks).toBe(
      "2026-12-01T19:30:00Z",
    );
  });

  it("adds no lock of its own to settings that close sign-up after the deadline", () => {
    const bad = { ...LISTED, registration_closes: "2026-12-01T22:00:00Z" };
    const r = settingsSchema.safeParse(withRosterLock(bad));
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual([
      "registration_closes",
    ]);
  });

  it("passes through what it can't read, for the schema to refuse", () => {
    expect(withRosterLock(null)).toBe(null);
    expect(withRosterLock([1])).toEqual([1]);
    const bad = { ...LISTED, deadline: "soon" };
    expect(withRosterLock(bad)).toBe(bad);
    const odd = { ...LISTED, roster_locks: "2026-12-01 19:30" };
    expect(withRosterLock(odd)).toBe(odd);
  });

  it("leaves a stored listing without one locking at the deadline in force", () => {
    const old = settingsSchema.parse(LISTED);
    expect(old.roster_locks).toBeUndefined();
    let s = withTeam(old);
    expect(rosterLocks(s)).toBe(DEADLINE);
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    expect(rosterLocks(s)).toBe(LATER);
    expect(
      ok(s, { type: "leave", by: "bob", at: LOCKED }).member_of.has("bob"),
    ).toBe(false);
  });
});

describe("validating roster_locks", () => {
  const issue = (over: object) => {
    const r = settingsSchema.safeParse({ ...LISTED, ...over });
    expect(r.success).toBe(false);
    return r.error?.issues.map((i) => [i.path.join("."), i.message]);
  };

  it("refuses a lock before sign-up closes", () => {
    expect(issue({ roster_locks: "2026-12-01T18:29:59Z" })).toEqual([
      ["roster_locks", "can't lock rosters before sign-up closes"],
    ]);
  });

  it("refuses a lock after the deadline", () => {
    expect(issue({ roster_locks: "2026-12-01T21:00:01Z" })).toEqual([
      ["roster_locks", "can't lock rosters after the deadline"],
    ]);
  });

  it("takes a lock at sign-up's close or at the deadline", () => {
    for (const at of [LISTED.registration_closes, LISTED.deadline])
      expect(
        settingsSchema.parse({ ...LISTED, roster_locks: at }).roster_locks,
      ).toBe(at);
  });

  it("refuses a lock that isn't a UTC time", () => {
    expect(
      settingsSchema.safeParse({ ...LISTED, roster_locks: "20:00" }).success,
    ).toBe(false);
  });
});

describe("rosters lock", () => {
  it("lets a team change until the lock, and not from it", () => {
    const s = withTeam();
    const before = new Date(Date.parse(LOCKS) - 1000).toISOString();
    expect(
      ok(s, { type: "leave", by: "bob", at: before }).member_of.has("bob"),
    ).toBe(false);
    expect(code(s, { type: "leave", by: "bob", at: LOCKS })).toBe(
      "roster_locked",
    );
    expect(code(s, { type: "leave", by: "bob", at: LOCKED })).toBe(
      "roster_locked",
    );
  });

  it("refuses making a team once locked, though a teamless bot could before", () => {
    const s = withTeam();
    expect(
      ok(s, {
        type: "make_team",
        by: "eve",
        at: BUILDING,
        name: "Eve",
      }).member_of.get("eve"),
    ).toBe(2);
    expect(
      code(s, { type: "make_team", by: "eve", at: LOCKED, name: "Eve" }),
    ).toBe("roster_locked");
  });

  it("refuses a team member's unregister once locked", () => {
    const s = withTeam();
    expect(code(s, { type: "unregister", by: "bob", at: LOCKED })).toBe(
      "roster_locked",
    );
  });

  it("lets a bot in no team unregister after the lock, since no roster changes", () => {
    const s = ok(withTeam(), { type: "unregister", by: "eve", at: LOCKED });
    expect(s.registered.has("eve")).toBe(false);
  });

  it("still takes a submission between the lock and the deadline", () => {
    const s = ok(withTeam(), {
      type: "submit",
      by: "ann",
      at: LOCKED,
      title: "late",
      pins: [PIN],
    });
    expect(s.teams.get(1)?.entries).toHaveLength(1);
  });

  it("answers a later deadline_passed before roster_locked", () => {
    const s = withTeam();
    expect(code(s, { type: "leave", by: "bob", at: DEADLINE })).toBe(
      "deadline_passed",
    );
    expect(code(s, { type: "unregister", by: "bob", at: DEADLINE })).toBe(
      "deadline_passed",
    );
  });

  it("isn't moved by an extension: the roster stays locked", () => {
    let s = withTeam();
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    expect(rosterLocks(s)).toBe(LOCKS);
    expect(code(s, { type: "leave", by: "bob", at: LOCKED })).toBe(
      "roster_locked",
    );
    expect(
      code(s, { type: "make_team", by: "eve", at: DEADLINE, name: "Eve" }),
    ).toBe("roster_locked");
    // Submitting runs on to the moved deadline.
    s = ok(s, {
      type: "submit",
      by: "ann",
      at: DEADLINE,
      title: "x",
      pins: [PIN],
    });
    expect(s.teams.get(1)?.entries[0]?.receipt.roster_locks).toBe(LOCKS);
  });

  it("answers a retry after the lock and an extension with the receipt's first lock", () => {
    const sub: Action = {
      type: "submit",
      by: "ann",
      at: BUILDING,
      title: "x",
      pins: [PIN],
      op: "first-try-1",
    };
    let s = ok(withTeam(), sub);
    const first = s.teams.get(1)?.entries[0]?.receipt;
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    const again = retryOf(s, { ...sub, at: LOCKED });
    expect(again).toEqual(first);
    expect(again?.roster_locks).toBe(LOCKS);
  });

  it("gives a team member who makes a team after the lock in_a_team, not roster_locked", () => {
    expect(
      code(withTeam(), { type: "make_team", by: "bob", at: LOCKED, name: "B" }),
    ).toBe("in_a_team");
  });

  it("puts the lock on the receipt", () => {
    const s = ok(withTeam(), {
      type: "submit",
      by: "ann",
      at: BUILDING,
      title: "x",
      pins: [PIN],
    });
    expect(s.teams.get(1)?.entries[0]?.receipt.roster_locks).toBe(LOCKS);
  });

  it("is open just before the lock and closed at it, or once cancelled", () => {
    const s = withTeam();
    expect(rosterOpen(s, BUILDING)).toBe(true);
    expect(rosterOpen(s, LOCKS)).toBe(false);
    const c = ok(s, { type: "cancel", by: "host-bot", at: BUILDING });
    expect(rosterOpen(c, BUILDING)).toBe(false);
  });
});

describe("the view's roster lock and next step", () => {
  it("shows the lock and whether rosters are open to anyone", () => {
    const s = withTeam();
    const open = view(s, null, BUILDING);
    expect([open.roster_locks, open.roster_open]).toEqual([LOCKS, true]);
    expect(open.next).toBeUndefined();
    expect(view(s, null, LOCKED).roster_open).toBe(false);
  });

  const nextOf = (s: State, who: string, at: string) => view(s, who, at).next;

  it("tells an unregistered bot to register while it can", () => {
    const s = withTeam();
    expect(nextOf(s, "zed", BEFORE)).toEqual({
      do: "register",
      until: LISTED.registration_closes,
    });
    expect(nextOf(s, "zed", BUILDING)).toEqual({ do: "nothing" });
  });

  it("tells an unregistered bot nothing when the event is full", () => {
    let s = start(
      settingsSchema.parse(withRosterLock({ ...LISTED, max_bots: 1 })),
    );
    s = ok(s, { type: "register", by: "ann", at: BEFORE });
    expect(nextOf(s, "zed", BEFORE)).toEqual({ do: "nothing" });
  });

  it("tells a teamless bot to make a team or ask, then to make one until the lock", () => {
    const s = withTeam();
    expect(nextOf(s, "eve", BEFORE)).toEqual({
      do: "make_team_or_ask",
      until: LISTED.registration_closes,
    });
    expect(nextOf(s, "eve", BUILDING)).toEqual({
      do: "make_team",
      until: LOCKS,
    });
    expect(nextOf(s, "eve", LOCKED)).toEqual({ do: "nothing" });
  });

  // ann's team of one, with bob and eve both asking to join it.
  function asked(): State {
    let s = start(SETTINGS);
    for (const by of ["ann", "bob", "eve"])
      s = ok(s, { type: "register", by, at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    return ok(s, { type: "ask", by: "eve", at: BEFORE, team: 1 });
  }

  it("tells a bot that asked to wait to be admitted", () => {
    expect(nextOf(asked(), "eve", BEFORE)).toEqual({
      do: "wait_for_admit",
      until: LISTED.registration_closes,
    });
  });

  it("tells a captain with room and an ask to admit, and one without room not to", () => {
    const s = asked();
    expect(nextOf(s, "ann", BEFORE)).toEqual({
      do: "admit",
      until: LISTED.registration_closes,
    });
    // Full with eve's ask still standing: it can't be admitted, so the
    // captain just waits for the start.
    const full = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    expect(full.asks.has("eve")).toBe(true);
    expect(nextOf(full, "ann", BEFORE)).toEqual({
      do: "wait_for_start",
      until: LISTED.starts_at,
    });
  });

  it("tells a team member to wait for the start, then to submit until the deadline", () => {
    let s = withTeam();
    expect(nextOf(s, "bob", BEFORE)).toEqual({
      do: "wait_for_start",
      until: LISTED.starts_at,
    });
    expect(nextOf(s, "bob", STARTED)).toEqual({
      do: "submit",
      until: DEADLINE,
    });
    expect(nextOf(s, "bob", LOCKED)).toEqual({ do: "submit", until: DEADLINE });
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    expect(nextOf(s, "bob", LOCKED)).toEqual({ do: "submit", until: LATER });
  });

  it("tells the host to wait for the deadline, then team members to wait for judging", () => {
    const s = withTeam();
    expect(nextOf(s, "host-bot", BUILDING)).toEqual({
      do: "wait_for_deadline",
      until: DEADLINE,
    });
    for (const who of ["ann", "bob"])
      expect(nextOf(s, who, DEADLINE)).toEqual({ do: "wait_for_judging" });
    for (const who of ["host-bot", "eve", "zed"])
      expect(nextOf(s, who, DEADLINE)).toEqual({ do: "nothing" });
  });

  it("tells a bot whose ask can no longer be admitted to make a team or ask again", () => {
    // eve asked the Owls, who then filled up with bob.
    let s = start(SETTINGS);
    for (const by of ["ann", "bob", "eve"])
      s = ok(s, { type: "register", by, at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
    s = ok(s, { type: "ask", by: "eve", at: BEFORE, team: 1 });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    expect(s.asks.has("eve")).toBe(true);
    expect(nextOf(s, "eve", BEFORE)).toEqual({
      do: "make_team_or_ask",
      until: LISTED.registration_closes,
    });
  });

  it("never tells a captain to admit after sign-up closes", () => {
    let s = start(
      settingsSchema.parse(withRosterLock({ ...LISTED, team_size: 3 })),
    );
    for (const by of ["ann", "bob"])
      s = ok(s, { type: "register", by, at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    expect(nextOf(s, "ann", BEFORE)).toMatchObject({ do: "admit" });
    expect(nextOf(s, "ann", BUILDING)).toEqual({
      do: "submit",
      until: DEADLINE,
    });
    expect(
      code(s, { type: "admit", by: "ann", at: BUILDING, who: "bob" }),
    ).toBe("registration_closed");
  });

  it("tells a team at its submission cap to wait for the deadline", () => {
    let s = withTeam();
    for (let i = 0; i < SUBMISSIONS_PER_TEAM; i++)
      s = ok(s, {
        type: "submit",
        by: i % 2 ? "ann" : "bob",
        at: BUILDING,
        title: `v${i}`,
        pins: [PIN],
      });
    expect(nextOf(s, "ann", BUILDING)).toEqual({
      do: "wait_for_deadline",
      until: DEADLINE,
    });
    expect(
      code(s, {
        type: "submit",
        by: "ann",
        at: BUILDING,
        title: "x",
        pins: [PIN],
      }),
    ).toBe("too_many_submissions");
  });

  it("tells a bot at its action count to wait, or nothing when it has no team", () => {
    let s = start(
      settingsSchema.parse(withRosterLock({ ...LISTED, team_size: 3 })),
    );
    for (const by of ["ann", "eve"])
      s = ok(s, { type: "register", by, at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
    // eve spends its count asking, round and round.
    for (let i = 2; i < ACTIONS_PER_BOT; i++)
      s = ok(s, { type: "ask", by: "eve", at: BEFORE, team: 1 });
    expect(s.acted.get("eve")).toBe(ACTIONS_PER_BOT - 1);
    s = ok(s, { type: "ask", by: "eve", at: BEFORE, team: 1 });
    expect(nextOf(s, "eve", BEFORE)).toEqual({ do: "nothing" });
    expect(
      code(s, { type: "make_team", by: "eve", at: BEFORE, name: "E" }),
    ).toBe("too_many_actions");
    // Gone and back would take a counted action it no longer has.
    const gone = ok(s, { type: "unregister", by: "eve", at: BEFORE });
    expect(nextOf(gone, "eve", BEFORE)).toEqual({ do: "nothing" });
    expect(code(gone, { type: "register", by: "eve", at: BEFORE })).toBe(
      "too_many_actions",
    );
    // ann admits eve; in a team at its count, eve waits for the deadline.
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "eve" });
    expect(nextOf(s, "eve", STARTED)).toEqual({
      do: "wait_for_deadline",
      until: DEADLINE,
    });
  });

  it("tells a bot outside the sign-up cap nothing, and one inside it to register again", () => {
    let s = start(
      settingsSchema.parse(withRosterLock({ ...LISTED, max_bots: 1 })),
    );
    // Two different bots ever: the cap for one seat.
    s = ok(s, { type: "register", by: "ann", at: BEFORE });
    s = ok(s, { type: "unregister", by: "ann", at: BEFORE });
    s = ok(s, { type: "register", by: "bob", at: BEFORE });
    s = ok(s, { type: "unregister", by: "bob", at: BEFORE });
    expect(nextOf(s, "zed", BEFORE)).toEqual({ do: "nothing" });
    expect(code(s, { type: "register", by: "zed", at: BEFORE })).toBe(
      "too_many_sign_ups",
    );
    expect(nextOf(s, "ann", BEFORE)).toEqual({
      do: "register",
      until: LISTED.registration_closes,
    });
  });

  it("tells a teamless bot nothing once rosters lock, though it may still unregister", () => {
    const s = withTeam();
    expect(nextOf(s, "eve", LOCKED)).toEqual({ do: "nothing" });
  });

  it("on an older listing, tells a teamless bot to make a team until the deadline in force", () => {
    let s = withTeam(settingsSchema.parse(LISTED));
    expect(nextOf(s, "eve", BUILDING)).toEqual({
      do: "make_team",
      until: DEADLINE,
    });
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    expect(nextOf(s, "eve", LOCKED)).toEqual({ do: "make_team", until: LATER });
  });

  it("tells everyone nothing once cancelled", () => {
    const s = ok(withTeam(), { type: "cancel", by: "host-bot", at: BUILDING });
    for (const who of ["host-bot", "ann", "eve", "zed"])
      expect(nextOf(s, who, BUILDING)).toEqual({ do: "nothing" });
  });
});
