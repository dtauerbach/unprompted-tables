import { describe, expect, it } from "vitest";
import {
  ACTIONS_PER_BOT,
  type Accepted,
  type Action,
  apply,
  type Event,
  entryInForce,
  phase,
  type Refusal,
  replay,
  SIGN_UPS_PER_SEAT,
  type State,
  SUBMISSIONS_PER_TEAM,
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
    for (const h of ["bot-b1", "bot-b2", "bot-b3", "bot-b4", "bot-b5"])
      s = ok(s, { type: "register", by: h, at: BEFORE });
    expect(code(s, { type: "register", by: "bot-b6", at: BEFORE })).toBe(
      "full",
    );
    s = ok(s, { type: "unregister", by: "bot-b5", at: BEFORE });
    s = ok(s, { type: "register", by: "bot-b6", at: BEFORE });
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
    for (const h of ["ann-a1", "ann-a2", "ann-a3", "ann-a4"])
      s = ok(s, { type: "register", by: h, at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann-a1", at: BEFORE, name: "One" });
    s = ok(s, { type: "make_team", by: "ann-a2", at: BEFORE, name: "Two" });
    s = ok(s, { type: "make_team", by: "ann-a3", at: BEFORE, name: "Three" });
    expect(
      code(s, { type: "make_team", by: "ann-a4", at: BEFORE, name: "Four" }),
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

describe("untrusted input", () => {
  it("refuses anything that isn't exactly an action", () => {
    const s = withTeam();
    const bad: unknown[] = [
      null,
      "register",
      { type: "register", by: "cat", at: BEFORE, junk: "x" },
      { type: "register", at: BEFORE },
      { type: "register", by: 7, at: BEFORE },
      { type: "register", by: "ab", at: BEFORE },
      { type: "register", by: "Cat", at: BEFORE },
      { type: "register", by: "cat", at: [BEFORE] },
      { type: "register", by: "cat", at: "2026-02-31T00:00:00Z" },
      { type: "register", by: "cat", at: "2026-12-01T24:00:00Z" },
      { type: "register", by: "cat", at: "2026-12-01T17:00:00+00:00" },
      { type: "teleport", by: "cat", at: BEFORE },
      { type: "admit", by: "ann", at: BEFORE, who: "not a handle" },
      { type: "ask", by: "bob", at: BEFORE, team: 1.5 },
      { type: "ask", by: "bob", at: BEFORE, team: "1" },
      {
        type: "submit",
        by: "ann",
        at: BUILDING,
        title: "x",
        pins: [PIN],
        team: 7,
      },
    ];
    for (const input of bad) {
      const r = apply(s, input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      expect((r as Refusal).code).toBe("invalid");
    }
  });

  it("stores its own copy, so a caller changing its action changes nothing", () => {
    const act = {
      type: "submit" as const,
      by: "ann",
      at: BUILDING,
      title: "mine",
      pins: [{ ...PIN }],
    };
    const r = apply(withTeam(), act) as Accepted;
    act.title = "CHANGED";
    act.pins[0] = { ...PIN, ref: "CHANGED" };
    (act.pins as { ref: string }[]).forEach((p) => {
      p.ref = "CHANGED";
    });
    const last = r.state.events.at(-1);
    expect(last).toMatchObject({ title: "mine", pins: [PIN] });
    // Nor does changing the answer it got back.
    for (const p of (r.event as { pins: { ref: string }[] }).pins)
      p.ref = "CHANGED";
    expect(r.state.events.at(-1)).toMatchObject({ pins: [PIN] });
    const again = replay(SETTINGS, JSON.parse(JSON.stringify(r.state.events)));
    expect(again.teams).toEqual(r.state.teams);
  });

  it("refuses every kind of invisible or unstorable character in a name", () => {
    const s = withTeam();
    const names = [
      "ㅤ",
      "⠀",
      "ﾠ",
      "a️b",
      "a\u{E0100}b",
      "a͏b",
      "a᠎b",
      "ab",
      "a\uD800b",
      "a b",
      "a‮b",
      "a\u17B4b",
      "a\u17B5",
    ];
    for (const name of names)
      expect(
        code(s, { type: "make_team", by: "bob", at: BEFORE, name }),
        JSON.stringify(name),
      ).toBe("invalid");
    expect(
      apply(s, {
        type: "make_team",
        by: "bob",
        at: BEFORE,
        name: "Équipe 東京",
      }).ok,
    ).toBe(true);
  });

  it("counts names that differ only in case folding or width as one", () => {
    let s = start(SETTINGS);
    s = ok(s, { type: "register", by: "ann", at: BEFORE });
    s = ok(s, { type: "register", by: "bob", at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "straße" });
    expect(
      code(s, { type: "make_team", by: "bob", at: BEFORE, name: "STRASSE" }),
    ).toBe("name_taken");
    expect(
      code(s, {
        type: "make_team",
        by: "bob",
        at: BEFORE,
        name: "ｓｔｒａｓｓｅ",
      }),
    ).toBe("name_taken");
  });
});

describe("dropping off", () => {
  it("lets a bot left alone after sign-up closes build as a team of one", () => {
    let s = withTeam();
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    s = ok(s, { type: "leave", by: "bob", at: BUILDING });
    s = ok(s, { type: "make_team", by: "bob", at: BUILDING, name: "Solo" });
    s = ok(s, {
      type: "submit",
      by: "bob",
      at: BUILDING,
      title: "x",
      pins: [PIN],
    });
    expect(s.teams.get(2)?.entries).toHaveLength(1);
    expect(code(s, { type: "ask", by: "bob", at: BUILDING, team: 1 })).toBe(
      "registration_closed",
    );
  });

  it("lets a bot left alone after sign-up closes make a team past the cap", () => {
    let s = start({ ...SETTINGS, max_teams: 2 });
    for (const h of ["ann", "bob", "cat"])
      s = ok(s, { type: "register", by: h, at: BEFORE });
    s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "One" });
    s = ok(s, { type: "make_team", by: "bob", at: BEFORE, name: "Two" });
    s = ok(s, { type: "ask", by: "cat", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "cat" });
    expect(
      code(s, { type: "make_team", by: "cat", at: BEFORE, name: "X" }),
    ).toBe("in_a_team");
    s = ok(s, { type: "leave", by: "cat", at: BUILDING });
    s = ok(s, { type: "make_team", by: "cat", at: BUILDING, name: "Three" });
    expect(s.teams.size).toBe(3);
  });

  it("refuses a new team at the deadline", () => {
    let s = withTeam();
    s = ok(s, { type: "leave", by: "ann", at: BUILDING });
    expect(
      code(s, { type: "make_team", by: "ann", at: DEADLINE, name: "Late" }),
    ).toBe("deadline_passed");
  });

  it("keeps asks to a team whose captain leaves, and drops them when it ends", () => {
    let s = withTeam();
    s = ok(s, { type: "register", by: "cat", at: BEFORE });
    s = ok(s, { type: "register", by: "dan", at: BEFORE });
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "ask", by: "cat", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    s = ok(s, { type: "unregister", by: "ann", at: BEFORE });
    // bob leads now, and cat's ask is his to answer.
    s = ok(s, { type: "admit", by: "bob", at: BEFORE, who: "cat" });
    s = ok(s, { type: "leave", by: "bob", at: BEFORE });
    s = ok(s, { type: "ask", by: "dan", at: BEFORE, team: 1 });
    s = ok(s, { type: "leave", by: "cat", at: BEFORE });
    expect(s.teams.has(1)).toBe(false);
    expect(s.asks.has("dan")).toBe(false);
  });
});

describe("bounds", () => {
  it("gives each bot a fixed number of actions in one hackathon, the host's cancel aside", () => {
    let s = withTeam();
    let accepted = 2;
    for (;;) {
      const a: Action = s.member_of.has("ann")
        ? { type: "leave", by: "ann", at: BUILDING }
        : {
            type: "make_team",
            by: "ann",
            at: BUILDING,
            name: `Owls ${accepted}`,
          };
      const r = apply(s, a);
      if (!r.ok) {
        expect(a.type).toBe("make_team");
        expect(r.code).toBe("too_many_actions");
        break;
      }
      s = r.state;
      accepted += 1;
    }
    // ann reaches the count in a team; leaving is never refused for it, so
    // she goes one past, and making a team, which it does refuse, can't follow.
    expect(accepted).toBe(ACTIONS_PER_BOT + 1);
    // bob is untouched by ann's count, and the host can still call it off.
    s = ok(s, { type: "unregister", by: "bob", at: BUILDING });
    s = ok(s, { type: "cancel", by: "host-bot", at: BUILDING });
    expect(phase(s, BUILDING)).toBe("cancelled");
  });

  it("lets a bot at its count still leave its team and the hackathon", () => {
    let s = withTeam();
    s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
    s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
    // bob has used its count while in ann's team.
    s.acted.set("bob", ACTIONS_PER_BOT);
    expect(code(s, { type: "ask", by: "bob", at: BEFORE, team: 1 })).toBe(
      "too_many_actions",
    );
    s = ok(s, { type: "leave", by: "bob", at: BEFORE });
    expect(
      code(s, { type: "make_team", by: "bob", at: BEFORE, name: "Larks" }),
    ).toBe("too_many_actions");
    s = ok(s, { type: "unregister", by: "bob", at: BEFORE });
    expect(s.registered.has("bob")).toBe(false);
    expect(code(s, { type: "register", by: "bob", at: BEFORE })).toBe(
      "too_many_actions",
    );
  });

  it("takes no new bots once twice its seats have ever signed up", () => {
    let s = start(SETTINGS);
    const cap = SIGN_UPS_PER_SEAT * SETTINGS.max_bots;
    for (let b = 0; b < cap; b++) {
      s = ok(s, { type: "register", by: `bot-${b}`, at: BEFORE });
      s = ok(s, { type: "unregister", by: `bot-${b}`, at: BEFORE });
    }
    expect(s.registered.size).toBe(0);
    expect(code(s, { type: "register", by: "new-bot", at: BEFORE })).toBe(
      "too_many_sign_ups",
    );
    // A bot that signed up before may come back.
    const back = apply(s, { type: "register", by: "bot-0", at: BEFORE });
    expect(back.ok).toBe(true);
    // Applying copies the set: the state it was handed is unchanged.
    expect(s.registered.has("bot-0")).toBe(false);
    expect(s.ever.size).toBe(cap);
    const fresh = apply(start(SETTINGS), {
      type: "register",
      by: "new-bot",
      at: BEFORE,
    }) as Accepted;
    expect(fresh.state.ever.has("new-bot")).toBe(true);
    // And replay builds it from the list alone.
    const again = replay(SETTINGS, s.events);
    expect(again.ever.size).toBe(cap);
    expect(code(again, { type: "register", by: "new-bot", at: BEFORE })).toBe(
      "too_many_sign_ups",
    );
  });

  it("leaves the state it was handed alone when it refuses", () => {
    const s = withTeam();
    const before = new Map(s.acted);
    const events = s.events.length;
    expect(code(s, { type: "register", by: "ann", at: BEFORE })).toBe(
      "already_registered",
    );
    expect(code(s, { type: "admit", by: "bob", at: BEFORE, who: "ann" })).toBe(
      "not_in_a_team",
    );
    expect(s.acted).toEqual(before);
    expect(s.events).toHaveLength(events);
    const ever = new Set(s.ever);
    apply(s, { type: "register", by: "cat", at: BEFORE });
    expect(s.ever).toEqual(ever);
    // An accepted action counts only in the state it returns.
    const r = apply(s, { type: "leave", by: "ann", at: BEFORE }) as Accepted;
    expect(r.ok).toBe(true);
    expect(r.state.acted.get("ann")).toBe((before.get("ann") ?? 0) + 1);
    expect(s.acted).toEqual(before);
  });

  it("keeps a team's submissions to a fixed number", () => {
    let s = withTeam();
    for (let i = 0; i < SUBMISSIONS_PER_TEAM; i++)
      s = ok(s, {
        type: "submit",
        by: "ann",
        at: BUILDING,
        title: `v${i}`,
        pins: [PIN],
      });
    expect(
      code(s, {
        type: "submit",
        by: "ann",
        at: BUILDING,
        title: "one more",
        pins: [PIN],
      }),
    ).toBe("too_many_submissions");
    expect(entryInForce(s.teams.get(1) as never)).toMatchObject({
      title: `v${SUBMISSIONS_PER_TEAM - 1}`,
    });
  });

  it("replays the longest list the bounds allow in time linear in its length", () => {
    const big = settingsSchema.parse({
      ...SETTINGS,
      max_teams: 64,
      team_size: 8,
      max_bots: 512,
    });
    // Twice max_bots bots sign up in turn, each using its count making and
    // leaving teams, then leaving the team and the hackathon past it.
    const events: Event[] = [];
    let team = 0;
    for (let b = 0; b < SIGN_UPS_PER_SEAT * 512; b++) {
      const by = `bot-${b}`;
      events.push({ type: "register", by, at: BEFORE });
      for (let k = 0; k < (ACTIONS_PER_BOT - 2) / 2; k++) {
        team += 1;
        events.push({
          type: "make_team",
          by,
          at: BEFORE,
          name: `t${team}`,
          team,
        });
        events.push({ type: "leave", by, at: BEFORE });
      }
      team += 1;
      events.push({
        type: "make_team",
        by,
        at: BEFORE,
        name: `t${team}`,
        team,
      });
      events.push({ type: "leave", by, at: BEFORE });
      events.push({ type: "unregister", by, at: BEFORE });
    }
    expect(events).toHaveLength(
      SIGN_UPS_PER_SEAT * 512 * (ACTIONS_PER_BOT + 2),
    );
    const started = performance.now();
    const s = replay(big, events);
    const took = performance.now() - started;
    expect(s.events).toHaveLength(events.length);
    expect(s.teams_made).toBe(team);
    // Quadratic replay took seconds at this length; linear takes a fraction.
    // The bound is loose so a slow CI machine doesn't fail it.
    expect(took).toBeLessThan(5000);
  });
});
