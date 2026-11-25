import { describe, expect, it } from "vitest";
import { type Action, apply, type State, start } from "./event";
import { type Settings, settingsSchema } from "./settings";
import { NOTICE, view } from "./view";

const SETTINGS: Settings = settingsSchema.parse({
  event: "jam-1",
  host: "host-bot",
  starts_at: "2026-12-01T18:00:00Z",
  registration_closes: "2026-12-01T18:30:00Z",
  deadline: "2026-12-01T21:00:00Z",
  max_teams: 4,
  team_size: 3,
  max_bots: 10,
});

const BEFORE = "2026-12-01T17:00:00Z";
const BUILDING = "2026-12-01T19:00:00Z";
const DEADLINE = "2026-12-01T21:00:00Z";
const PIN = { store: "github", ref: "acme/jam", revision: "abc123" };

function run(actions: Action[]): State {
  let s = start(SETTINGS);
  for (const a of actions) {
    const r = apply(s, a);
    if (!r.ok) throw new Error(`${a.type} refused: ${r.code}`);
    s = r.state;
  }
  return s;
}

// Two teams: Owls (ann, bob) and Cats (cat), dan asking to join the Owls.
// Both teams submit; the Owls twice.
const s = run([
  { type: "register", by: "ann", at: BEFORE },
  { type: "register", by: "bob", at: BEFORE },
  { type: "register", by: "cat", at: BEFORE },
  { type: "register", by: "dan", at: BEFORE },
  { type: "make_team", by: "ann", at: BEFORE, name: "Owls" },
  { type: "make_team", by: "cat", at: BEFORE, name: "Cats" },
  { type: "ask", by: "bob", at: BEFORE, team: 1 },
  { type: "admit", by: "ann", at: BEFORE, who: "bob" },
  { type: "ask", by: "dan", at: BEFORE, team: 1 },
  { type: "submit", by: "ann", at: BUILDING, title: "first", pins: [PIN] },
  { type: "submit", by: "bob", at: BUILDING, title: "second", pins: [PIN] },
  { type: "submit", by: "cat", at: BUILDING, title: "cats", pins: [PIN] },
]);

describe("views", () => {
  it("shows rosters to anyone, and no team's work before the deadline", () => {
    const v = view(s, null, BUILDING);
    expect(v.phase).toBe("building");
    expect(v.notice).toBe(NOTICE);
    expect(
      v.teams.map((t) => [t.untrusted_name, t.captain, t.members]),
    ).toEqual([
      ["Owls", "ann", ["ann", "bob"]],
      ["Cats", "cat", ["cat"]],
    ]);
    expect(v.teams.every((t) => t.submitted && !("entry" in t))).toBe(true);
    expect(v.you).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("first");
  });

  it("shows a member its own team's work, and only its own", () => {
    const bob = view(s, "bob", BUILDING);
    expect(bob.you?.entries?.map((e) => e.untrusted_title)).toEqual([
      "second",
      "first",
    ]);
    expect(JSON.stringify(bob)).not.toContain("cats");
    const cat = view(s, "cat", BUILDING);
    expect(JSON.stringify(cat)).not.toContain("second");
  });

  it("shows asks only to the asker and the captain", () => {
    expect(view(s, "ann", BEFORE).you?.asks).toEqual([
      { handle: "dan", at: BEFORE },
    ]);
    expect(view(s, "dan", BEFORE).you).toEqual({
      team: null,
      captain: false,
      asked: 1,
    });
    expect(view(s, "bob", BEFORE).you?.asks).toBeUndefined();
    expect(JSON.stringify(view(s, "cat", BEFORE))).not.toContain("dan");
    expect(JSON.stringify(view(s, null, BEFORE))).not.toContain("dan");
  });

  it("shows every team's entry in force to everyone from the deadline", () => {
    const v = view(s, null, DEADLINE);
    expect(v.phase).toBe("frozen");
    expect(v.teams.map((t) => t.entry?.untrusted_title)).toEqual([
      "second",
      "cats",
    ]);
    expect(view(s, "bob", DEADLINE).you?.entries).toBeUndefined();
  });

  it("never shows work when cancelled before the deadline", () => {
    const r = apply(s, { type: "cancel", by: "host-bot", at: BUILDING });
    if (!r.ok) throw new Error(r.code);
    const v = view(r.state, null, "2026-12-02T00:00:00Z");
    expect(v.phase).toBe("cancelled");
    expect(v.teams.some((t) => "entry" in t)).toBe(false);
  });

  it("keeps work shown when cancelled after the deadline", () => {
    const r = apply(s, { type: "cancel", by: "host-bot", at: DEADLINE });
    if (!r.ok) throw new Error(r.code);
    const v = view(r.state, null, DEADLINE);
    expect(v.teams[0]?.entry?.untrusted_title).toBe("second");
  });

  it("gives a reader copies, so changing a view changes nothing", () => {
    const v = view(s, null, DEADLINE);
    const pin = v.teams[0]?.entry?.pins[0];
    if (pin) pin.revision = "tampered";
    expect(view(s, null, DEADLINE).teams[0]?.entry?.pins[0]?.revision).toBe(
      "abc123",
    );
  });
});
