import { describe, expect, it } from "vitest";
import {
  type Action,
  apply,
  digest,
  EXTEND_NOTICE_MINUTES,
  EXTENSIONS_MAX,
  entryInForce,
  phase,
  type Receipt,
  type Refusal,
  replay,
  retryOf,
  type State,
  start,
} from "./event";
import { type Settings, settingsSchema } from "./settings";
import { revealed, view } from "./view";

// H2: the host moves the deadline later with notice, and a submission gets
// a receipt that a retry with the same op gets back unchanged.

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

function withTeam(): State {
  let s = start(SETTINGS);
  s = ok(s, { type: "register", by: "ann", at: BEFORE });
  s = ok(s, { type: "register", by: "bob", at: BEFORE });
  s = ok(s, { type: "make_team", by: "ann", at: BEFORE, name: "Owls" });
  s = ok(s, { type: "ask", by: "bob", at: BEFORE, team: 1 });
  s = ok(s, { type: "admit", by: "ann", at: BEFORE, who: "bob" });
  return s;
}

const minus = (iso: string, min: number) =>
  new Date(Date.parse(iso) - min * 60_000).toISOString();

describe("extending the deadline", () => {
  it("lets the host move it later, keeps sign-up where it was, and versions it", () => {
    let s = withTeam();
    expect(s.deadline_version).toBe(1);
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    expect(s.deadline).toBe(LATER);
    expect(s.deadline_version).toBe(2);
    // The listed settings never change.
    expect(s.settings.deadline).toBe(DEADLINE);
    // Building runs on past the old deadline, and a submission lands.
    expect(phase(s, DEADLINE)).toBe("building");
    s = ok(s, {
      type: "submit",
      by: "bob",
      at: DEADLINE,
      title: "late but in time",
      pins: [PIN],
    });
    expect(phase(s, LATER)).toBe("frozen");
    expect(revealed(s, DEADLINE)).toBe(false);
    expect(revealed(s, LATER)).toBe(true);
    // Sign-up closed when it was listed to.
    expect(code(s, { type: "register", by: "cat", at: DEADLINE })).toBe(
      "registration_closed",
    );
    const v = view(s, null, BUILDING);
    expect(v).toMatchObject({
      deadline: LATER,
      deadline_version: 2,
      listed_deadline: DEADLINE,
      registration_closes: SETTINGS.registration_closes,
    });
    expect(view(start(SETTINGS), null, BEFORE).listed_deadline).toBeUndefined();
  });

  it("is the host's alone", () => {
    const s = withTeam();
    for (const by of ["ann", "bob", "stranger"])
      expect(
        code(s, { type: "extend", by, at: BUILDING, deadline: LATER }),
      ).toBe("not_host");
  });

  it(`must come at least ${EXTEND_NOTICE_MINUTES} minutes before the deadline in force`, () => {
    const s = withTeam();
    const lastChance = minus(DEADLINE, EXTEND_NOTICE_MINUTES);
    const tooLate = new Date(Date.parse(lastChance) + 1000).toISOString();
    expect(
      code(s, { type: "extend", by: "host-bot", at: tooLate, deadline: LATER }),
    ).toBe("too_late");
    expect(
      code(s, {
        type: "extend",
        by: "host-bot",
        at: DEADLINE,
        deadline: LATER,
      }),
    ).toBe("too_late");
    ok(s, { type: "extend", by: "host-bot", at: lastChance, deadline: LATER });
    // The notice runs from the deadline in force, not the listed one.
    const moved = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    ok(moved, {
      type: "extend",
      by: "host-bot",
      at: "2026-12-01T22:00:00Z",
      deadline: "2026-12-02T01:00:00Z",
    });
  });

  it("only moves it later, and never past seven days from the start", () => {
    const s = withTeam();
    for (const deadline of [
      DEADLINE,
      "2026-12-01T20:00:00Z",
      "2026-12-08T18:00:01Z",
    ])
      expect(
        code(s, { type: "extend", by: "host-bot", at: BUILDING, deadline }),
      ).toBe("bad_deadline");
    ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: "2026-12-08T18:00:00Z",
    });
  });

  it(`stops after ${EXTENSIONS_MAX} moves`, () => {
    let s = withTeam();
    let to = Date.parse(DEADLINE);
    for (let i = 0; i < EXTENSIONS_MAX; i++) {
      to += 60 * 60_000;
      s = ok(s, {
        type: "extend",
        by: "host-bot",
        at: BUILDING,
        deadline: new Date(to).toISOString(),
      });
    }
    expect(s.deadline_version).toBe(EXTENSIONS_MAX + 1);
    expect(
      code(s, {
        type: "extend",
        by: "host-bot",
        at: BUILDING,
        deadline: new Date(to + 60 * 60_000).toISOString(),
      }),
    ).toBe("too_many_extensions");
  });

  it("can't reopen a frozen or cancelled hackathon", () => {
    const s = withTeam();
    expect(
      code(s, {
        type: "extend",
        by: "host-bot",
        at: LATER,
        deadline: "2026-12-02T09:00:00Z",
      }),
    ).toBe("too_late");
    const gone = ok(s, { type: "cancel", by: "host-bot", at: BUILDING });
    expect(
      code(gone, {
        type: "extend",
        by: "host-bot",
        at: BUILDING,
        deadline: LATER,
      }),
    ).toBe("cancelled");
  });

  it("replays to the same deadline", () => {
    let s = withTeam();
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    const again = replay(SETTINGS, s.events);
    expect(again.deadline).toBe(LATER);
    expect(again.deadline_version).toBe(2);
  });
});

describe("receipts", () => {
  const submission = (over: Partial<Action> = {}) =>
    ({
      type: "submit",
      by: "bob",
      at: BUILDING,
      title: "Owl app",
      pins: [PIN],
      op: "op-0001-owl",
      ...over,
    }) as Action;

  it("hands back the team, the entry's number, the time, the deadline and a digest", () => {
    const s = withTeam();
    const r = apply(s, submission());
    if (!r.ok) throw new Error(r.code);
    expect(r.receipt).toEqual({
      event: "jam-1",
      team: 1,
      entry: 1,
      op: "op-0001-owl",
      at: BUILDING,
      deadline: DEADLINE,
      deadline_version: 1,
      digest: digest({ title: "Owl app", pins: [PIN] }),
    } satisfies Receipt);
    expect(r.receipt?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The entry carries it, and the view shows its number and digest.
    expect(entryInForce(r.state.teams.get(1) as never)?.receipt).toEqual(
      r.receipt,
    );
    const mine = view(r.state, "ann", BUILDING).you?.entries?.[0];
    expect(mine).toMatchObject({ entry: 1, digest: r.receipt?.digest });
  });

  it("gives a submission without an op a receipt too, with op null", () => {
    const s = withTeam();
    const { op: _op, ...plain } = submission() as Extract<
      Action,
      { type: "submit" }
    >;
    const r = apply(s, plain);
    if (!r.ok) throw new Error(r.code);
    expect(r.receipt).toMatchObject({ op: null, entry: 1 });
    expect(retryOf(r.state, plain)).toBeNull();
  });

  it("says which deadline a submission was made under", () => {
    let s = withTeam();
    s = ok(s, {
      type: "extend",
      by: "host-bot",
      at: BUILDING,
      deadline: LATER,
    });
    const r = apply(s, submission());
    if (!r.ok) throw new Error(r.code);
    expect(r.receipt).toMatchObject({ deadline: LATER, deadline_version: 2 });
  });

  it("gives a retry the first receipt, even after the deadline and after leaving", () => {
    let s = withTeam();
    const first = apply(s, submission());
    if (!first.ok) throw new Error(first.code);
    s = first.state;
    s = ok(s, { type: "leave", by: "bob", at: BUILDING });
    // A retry's own time doesn't matter: it's past the deadline here.
    const again = retryOf(s, submission({ at: LATER }));
    expect(again).toEqual(first.receipt);
    // Keys in another order are the same work.
    const reordered = retryOf(s, {
      op: "op-0001-owl",
      pins: [{ revision: PIN.revision, ref: PIN.ref, store: PIN.store }],
      title: "Owl app",
      at: LATER,
      by: "bob",
      type: "submit",
    });
    expect(reordered).toEqual(first.receipt);
  });

  it("refuses the same op for other work, and another bot's op is its own", () => {
    let s = withTeam();
    s = ok(s, submission());
    const other = submission({ title: "Owl app v2" });
    expect(retryOf(s, other)).toBeNull();
    expect(code(s, other)).toBe("op_used");
    const otherPin = submission({
      pins: [{ ...PIN, revision: "ffff000" }],
    });
    expect(code(s, otherPin)).toBe("op_used");
    // The op names one bot's submission: ann's same op is ann's first.
    expect(retryOf(s, submission({ by: "ann" }))).toBeNull();
    const ann = apply(s, submission({ by: "ann" }));
    expect(ann.ok && ann.receipt?.entry).toBe(2);
  });

  it("checks an op's shape", () => {
    const s = withTeam();
    for (const op of ["short", "has space here", "x".repeat(65), "a/b/c/d/e"])
      expect(code(s, submission({ op }))).toBe("invalid");
  });

  it("rebuilds receipts and ops on replay", () => {
    let s = withTeam();
    s = ok(s, submission());
    s = ok(s, submission({ op: "op-0002-owl", title: "v2" }));
    const again = replay(SETTINGS, s.events);
    expect(again.ops.size).toBe(2);
    expect(entryInForce(again.teams.get(1) as never)?.receipt).toMatchObject({
      entry: 2,
      op: "op-0002-owl",
    });
    expect(code(again, submission({ title: "other" }))).toBe("op_used");
  });
});
