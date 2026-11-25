import { describe, expect, it } from "vitest";
import {
  type Accepted,
  type Action,
  apply,
  entryInForce,
  phase,
  type Refusal,
  replay,
  type State,
  start,
} from "./event";
import { type Settings, settingsSchema } from "./settings";

const SETTINGS: Settings = settingsSchema.parse({
  event: "jam-1",
  host: "host-bot",
  starts_at: "2026-12-01T18:00:00Z",
  registration_closes: "2026-12-01T18:30:00Z",
  deadline: "2026-12-01T21:00:00Z",
  max_teams: 3,
  team_size: 2,
  max_bots: 6,
});

const BEFORE = "2026-12-01T17:00:00Z";
const BUILDING = "2026-12-01T19:00:00Z";
// Building has started and sign-up is still open.
const LATE_JOIN = "2026-12-01T18:10:00Z";
const DEADLINE = "2026-12-01T21:00:00Z";
const AFTER = "2026-12-01T22:00:00Z";

const PIN = { store: "github", ref: "acme/jam#main", revision: "a1b2c3d" };

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

// Two signed-up bots, ann in team 1 as its captain.
function withTeam(): State {
  let s = start(SETTINGS);
  s = ok(s, { type: "register", by: "ann", at: BEFORE });
  s = ok(s, { type: "register", by: "bob", at: BEFORE });
  s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
  return s;
}

describe("settings", () => {
  it("refuses sign-up that closes outside the start and the deadline", () => {
    const early = settingsSchema.safeParse({
      ...SETTINGS,
      registration_closes: "2026-12-01T17:59:00Z",
    });
    const late = settingsSchema.safeParse({
      ...SETTINGS,
      registration_closes: "2026-12-01T21:01:00Z",
    });
    expect(early.success).toBe(false);
    expect(late.success).toBe(false);
  });

  it("holds the build to between 30 minutes and 7 days", () => {
    const short = { ...SETTINGS, registration_closes: SETTINGS.starts_at };
    expect(
      settingsSchema.safeParse({ ...short, deadline: "2026-12-01T18:29:00Z" })
        .success,
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ ...short, deadline: "2026-12-01T18:30:00Z" })
        .success,
    ).toBe(true);
    expect(
      settingsSchema.safeParse({ ...short, deadline: "2026-12-08T18:00:01Z" })
        .success,
    ).toBe(false);
  });
});

describe("phases", () => {
  it("runs registration, building and frozen by the clock alone", () => {
    const s = start(SETTINGS);
    expect(phase(s, BEFORE)).toBe("registration");
    expect(phase(s, SETTINGS.starts_at)).toBe("building");
    expect(phase(s, "2026-12-01T20:59:59.999Z")).toBe("building");
    expect(phase(s, DEADLINE)).toBe("frozen");
  });

  it("stays cancelled once the host cancels", () => {
    let s = start(SETTINGS);
    expect(code(s, { type: "cancel", by: "ann", at: BEFORE })).toBe("not_host");
    s = ok(s, { type: "cancel", by: "host-bot", at: BEFORE });
    expect(phase(s, AFTER)).toBe("cancelled");
    expect(code(s, { type: "register", by: "ann", at: BEFORE })).toBe(
      "cancelled",
    );
  });
});

describe("sign-up", () => {
  it("takes late joiners until registration closes, then refuses", () => {
    let s = start(SETTINGS);
    s = ok(s, { type: "register", by: "ann", at: "2026-12-01T18:29:59Z" });
    expect(
      code(s, { type: "register", by: "bob", at: "2026-12-01T18:30:00Z" }),
    ).toBe("registration_closed");
  });

  it("keeps the host out, counts places and refuses a second sign-up", () => {
    let s = start(SETTINGS);
    expect(code(s, { type: "register", by: "host-bot", at: BEFORE })).toBe(
      "host",
    );
    s = ok(s, { type: "register", by: "ann", at: BEFORE });
    expect(code(s, { type: "register", by: "ann", at: BEFORE })).toBe(
      "already_registered",
    );
    for (const h of ["b1", "b2", "b3", "b4", "b5"])
      s = ok(s, { type: "register", by: h, at: BEFORE });
    expect(code(s, { type: "register", by: "b6", at: BEFORE })).toBe("full");
    s = ok(s, { type: "unregister", by: "b5", at: BEFORE });
    s = ok(s, { type: "register", by: "b6", at: BEFORE });
    expect(s.registered.size).toBe(6);
  });

  it("refuses an action timed before the last one", () => {
    let s = start(SETTINGS);
    s = ok(s, { type: "register", by: "ann", at: LATE_JOIN });
    expect(code(s, { type: "register", by: "bob", at: BEFORE })).toBe("clock");
    expect(code(s, { type: "register", by: "bob", at: "yesterday" })).toBe(
      "invalid",
    );
  });
});

describe("teams", () => {
  it("makes the maker captain, numbers teams and keeps names apart", () => {
    let s = withTeam();
    const t = s.teams.get(1);
    expect(t?.members.map((m) => m.handle)).toEqual(["ann"]);
    expect(
      code(s, { type: "make_team", by: "bob", at: BEFORE, name: "owls" }),
    ).toBe("name_taken");
    expect(
      code(s, { type: "make_team", by: "carl", at: BEFORE, name: "Hawks" }),
    ).toBe("not_registered");
    expect(
      code(s, { type: "make_team", by: "ann", at: BEFORE, name: "Hawks" }),
    ).toBe("in_a_team");
    s = ok(s, { type: "make_team", by: "bob", at: BEFORE, name: "Hawks" });
    expect(s.teams.get(2)?.name).toBe("Hawks");
  });

  it("refuses a name on more than one line or with hidden characters", () => {
    const s = withTeam();
    for (const name of ["Two\nlines", "zero​width", " padded", ""])
      expect(code(s, { type: "make_team", by: "bob", at: BEFORE, name })).toBe(
        "invalid",
      );
  });

  it("caps the number of teams", () => {
    let s = start(SETTINGS);
    for (const h of ["a1", "a2", "a3", "a4"])
      s = ok(s, { type: "register", by: h, at: BEFORE });
    s = ok(s, { type: "make_team", by: "a1", at: BEFORE, name: "One" });
    s = ok(s, { type: "make_team", by: "a2", at: BEFORE, name: "Two" });
    s = ok(s, { type: "make_team", by: "a3", at: BEFORE, name: "Three" });
    expect(
      code(s, { type: "make_team", by: "a4", at: BEFORE, name: "Four" }),
    ).toBe("too_many_teams");
  });

  it("lets a bot in only when it asked and its captain admits it", () => {
    let s = withTeam();
    expect(code(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" })).toBe(
      "no_ask",
    );
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    expect(code(s, { type: "admit", by: "bob", at: BEFORE, who: "bob" })).toBe(
      "not_in_a_team",
    );
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    expect(s.teams.get(1)?.members.map((m) => m.handle)).toEqual([
      "ann",
      "bob",
    ]);
    expect(s.asks.has("bob")).toBe(false);
    expect(code(s, { type: "admit", by: "bob", at: BEFORE, who: "ann" })).toBe(
      "not_captain",
    );
  });

  it("refuses an ask to a full team, a made-up one, or after sign-up closes", () => {
    let s = withTeam();
    s = ok(s, { type: "register", by: "cat", at: BEFORE });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "ask", by: "cat", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    expect(code(s, { type: "admit", by: "ann", at: BEFORE, who: "cat" })).toBe(
      "team_full",
    );
    expect(code(s, { type: "ask", by: "cat", at: BEFORE, team: 1 })).toBe(
      "team_full",
    );
    expect(code(s, { type: "ask", by: "cat", at: BEFORE, team: 9 })).toBe(
      "no_such_team",
    );
    s = ok(s, { type: "leave", by: "bob", at: BUILDING });
    expect(code(s, { type: "ask", by: "cat", at: BUILDING, team: 1 })).toBe(
      "registration_closed",
    );
  });

  it("drops an ask that the bot replaced or outgrew", () => {
    let s = withTeam();
    s = ok(s, { type: "register", by: "cat", at: BEFORE });
    s = ok(s, { type: "make_team", by: "cat", at: BEFORE, name: "Cats" });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 2 });
    expect(code(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" })).toBe(
      "no_ask",
    );
    s = ok(s, { type: "make_team", by: "bob", at: BEFORE, name: "Bobs" });
    expect(code(s, { type: "admit", by: "cat", at: BEFORE, who: "bob" })).toBe(
      "no_ask",
    );
  });

  it("hands the lead to the longest-standing member, and ends an empty team", () => {
    let s = withTeam();
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    s = ok(s, { type: "leave", by: "ann", at: LATE_JOIN });
    expect(s.teams.get(1)?.members[0]?.handle).toBe("bob");
    s = ok(s, {
      type: "submit",
      by: "bob",
      at: LATE_JOIN,
      title: "Thing",
      pins: [PIN],
    });
    s = ok(s, { type: "unregister", by: "bob", at: LATE_JOIN });
    expect(s.teams.has(1)).toBe(false);
    // An ended team's number is never reused.
    s = ok(s, { type: "make_team", by: "ann", at: LATE_JOIN, name: "Owls" });
    expect([...s.teams.keys()]).toEqual([2]);
  });
});

describe("submissions", () => {
  it("opens at the start and closes strictly before the deadline", () => {
    const s = withTeam();
    const sub = {
      type: "submit" as const,
      by: "ann",
      title: "Thing",
      pins: [PIN],
    };
    expect(code(s, { ...sub, at: BEFORE })).toBe("not_started");
    expect(code(s, { ...sub, at: DEADLINE })).toBe("deadline_passed");
    expect(code(s, { ...sub, by: "bob", at: BUILDING })).toBe("not_in_a_team");
    const r = apply(s, { ...sub, at: "2026-12-01T20:59:59.999Z" }) as Accepted;
    expect(r.ok).toBe(true);
  });

  it("keeps the newest before the deadline in force, and every earlier one", () => {
    let s = withTeam();
    s = ok(s, {
      type: "submit",
      by: "ann",
      at: BUILDING,
      title: "v1",
      pins: [PIN],
    });
    s = ok(s, {
      type: "submit",
      by: "ann",
      at: "2026-12-01T20:00:00Z",
      title: "v2",
      pins: [{ ...PIN, revision: "ffff" }],
    });
    const t = s.teams.get(1);
    expect(t?.entries.map((e) => e.title)).toEqual(["v1", "v2"]);
    expect(t && entryInForce(t)?.pins[0]?.revision).toBe("ffff");
  });

  it("freezes rosters and entries at the deadline", () => {
    let s = withTeam();
    s = ok(s, {
      type: "submit",
      by: "ann",
      at: BUILDING,
      title: "v1",
      pins: [PIN],
    });
    expect(code(s, { type: "leave", by: "ann", at: DEADLINE })).toBe(
      "deadline_passed",
    );
    expect(code(s, { type: "unregister", by: "ann", at: AFTER })).toBe(
      "deadline_passed",
    );
  });

  it("refuses a pin without a revision, a quote, or too many pins", () => {
    const s = withTeam();
    const at = BUILDING;
    const bad: unknown[] = [
      [{ store: "github", ref: "x" }],
      [{ ...PIN, ref: 'say "hi"' }],
      [{ ...PIN, ref: "back\\slash" }],
      [{ ...PIN, store: "GitHub" }],
      [{ ...PIN, extra: 1 }],
      Array.from({ length: 9 }, () => PIN),
      [],
    ];
    for (const pins of bad)
      expect(
        code(s, { type: "submit", by: "ann", at, title: "x", pins } as Action),
      ).toBe("invalid");
    expect(
      code(s, { type: "submit", by: "ann", at, title: "a\nb", pins: [PIN] }),
    ).toBe("invalid");
  });
});

describe("replay", () => {
  it("rebuilds the same state from the stored list", () => {
    let s = withTeam();
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    s = ok(s, {
      type: "submit",
      by: "bob",
      at: BUILDING,
      title: "v1",
      pins: [PIN],
    });
    const again = replay(SETTINGS, JSON.parse(JSON.stringify(s.events)));
    expect(again.teams).toEqual(s.teams);
    expect(again.registered).toEqual(s.registered);
    expect(again.events).toEqual(s.events);
  });

  it("throws on a list the rules no longer accept", () => {
    const s = withTeam();
    const events = [...s.events];
    events.push({
      type: "submit",
      by: "ann",
      at: BEFORE,
      title: "x",
      pins: [PIN],
    });
    expect(() => replay(SETTINGS, events)).toThrow(/no longer applies/);
    const renumbered = s.events.map((e) =>
      e.type === "make_team" ? { ...e, team: 7 } : e,
    );
    expect(() => replay(SETTINGS, renumbered)).toThrow(/made team 1/);
  });

  it("leaves the state it was given alone when it refuses or accepts", () => {
    const s = withTeam();
    const before = JSON.stringify([...s.teams.values()]);
    apply(s, {
      type: "submit",
      by: "ann",
      at: BUILDING,
      title: "v1",
      pins: [PIN],
    });
    apply(s, { type: "leave", by: "ann", at: BUILDING });
    expect(JSON.stringify([...s.teams.values()])).toBe(before);
    expect(s.events).toHaveLength(3);
  });
});
