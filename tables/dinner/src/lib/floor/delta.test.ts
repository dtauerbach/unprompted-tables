import { cursorScope, openCursor, sealCursor } from "@unprompted-tables/server";
import { describe, expect, it } from "vitest";
import { present } from "../store";
import { delta, EXECUTIVES, view } from "./game";
import { floorMatch, ID, PLAYERS, QUICK, SEATINGS } from "./test-harness";

// The open floor's delta read. Its cursor counts only the events a reader
// can see, so private talk, sealed ballots and guesses between others
// never move it or show through it; and a cursor is sealed to one reader
// of one match, so another reader's, another match's or a forged one gets
// the reader's own whole view again, never anyone else's events. A stale
// but genuine cursor gets everything since it was issued.

const scope = (p: string | null) => cursorScope("dinner", ID, p);

// A delta that must not be a resync, typed as one.
function changes(...args: Parameters<typeof delta>) {
  const r = delta(...args);
  if ("resync" in r.view) throw new Error("unexpected resync");
  return { view: r.view, seen: r.seen };
}
const SECRET = "meet-me-by-the-coat-check";

// A match with talk, a private word between two executives, a guess, a
// motion with ballots and its close.
function played() {
  const g = floorMatch();
  const ex = (k: number) => EXECUTIVES[g.state.cast[k] as number] as string;
  g.talk(ex(0), "good evening all", 5);
  g.talk(ex(1), SECRET, 6, [ex(2)]);
  g.guess(ex(3), ex(0), ex(1) === ex(0) ? ex(2) : ex(1), 7);
  g.move(ex(4), SEATINGS[0] as string[], 181);
  g.vote(ex(0), 1, "yes", 182);
  g.vote(ex(3), 1, "no", 183);
  g.vote(ex(2), 1, "yes", 184);
  return { g, ex, insiders: [PLAYERS[1], PLAYERS[2]] as string[] };
}

describe("open floor delta reads", () => {
  it("join up: a reader's deltas, split anywhere, give each change once", () => {
    const { g } = played();
    for (const p of [...PLAYERS, null, "mallory"]) {
      const whole = changes(g.state, g.events, p, 0, {
        now: new Date(g.state.opened),
      }).view.events;
      for (let n = 4; n <= g.events.length; n++) {
        const first = changes(g.state, g.events.slice(0, n), p, 0);
        const rest = changes(g.state, g.events, p, first.seen);
        expect([...first.view.events, ...rest.view.events]).toEqual(whole);
      }
    }
  });

  it("binds a cursor to its match: the same reader's cursor elsewhere resyncs", () => {
    const { g } = played();
    const other = { ...g.state, id: "m_anothermatch" };
    const opts = { now: new Date(g.state.opened) };
    for (const p of [...PLAYERS, null]) {
      const whole = present(g.state, g.events, p, opts, undefined) as {
        next: string;
        talk: unknown[];
      };
      const here = present(g.state, g.events, p, opts, whole.next) as {
        events: unknown[];
        resync?: true;
      };
      expect(here.resync).toBeUndefined();
      expect(here.events).toEqual([]);
      // The same events under another match's id: the same count would
      // slice them to nothing, so only the binding gives the resync.
      const elsewhere = present(other, g.events, p, opts, whole.next) as {
        next: string;
        resync?: true;
      };
      expect(elsewhere.resync).toBe(true);
      // A resync is the whole view again, the talk and all.
      const { next: _a, resync: _r, ...rest } = elsewhere;
      const { next: _b, ...wholeRest } = whole;
      expect(rest).toEqual({ ...wholeRest, id: other.id });
      expect(whole.talk.length).toBeGreaterThan(0);
    }
  });

  it("shows the changes in the reader's own terms, and leaves out the rest", () => {
    const { g, insiders } = played();
    const d = changes(g.state, g.events, PLAYERS[0] as string, 0).view;
    expect(d.events.map((e) => e.kind)).toEqual([
      "talk",
      "moved",
      "your_ballot",
      "closed",
    ]);
    expect(d).not.toHaveProperty("rules");
    expect(d).not.toHaveProperty("likes");
    expect(d.you).not.toHaveProperty("brief");
    expect(d.you?.secret).toEqual(
      view(g.state, g.events, PLAYERS[0] as string).you?.secret,
    );
    expect(d.standing?.motion).toBe(1);
    expect(d.open_motions).toEqual([]);
    for (const p of insiders)
      expect(JSON.stringify(delta(g.state, g.events, p, 0).view)).toContain(
        SECRET,
      );
    for (const p of [PLAYERS[0], PLAYERS[3], PLAYERS[4], null, "mallory"])
      expect(
        JSON.stringify(delta(g.state, g.events, p as string | null, 0).view),
      ).not.toContain(SECRET);
    // The guesser alone sees its guess.
    const guessing = changes(g.state, g.events, PLAYERS[3] as string, 0).view
      .events;
    expect(guessing.some((e) => e.kind === "your_guess")).toBe(true);
    expect(
      changes(g.state, g.events, PLAYERS[4] as string, 0).view.events.some(
        (e) => e.kind === "your_guess",
      ),
    ).toBe(false);
  });

  it("an outsider's count doesn't move with private talk, ballots or guesses", () => {
    const quiet = floorMatch();
    const busy = floorMatch();
    const ex = (k: number) =>
      EXECUTIVES[busy.state.cast[k] as number] as string;
    busy.talk(ex(1), SECRET, 6, [ex(2)]);
    busy.guess(ex(3), ex(0), ex(1), 7);
    for (const g of [quiet, busy]) g.move(ex(4), SEATINGS[0] as string[], 181);
    busy.vote(ex(1), 1, "no", 182);
    for (const g of [quiet, busy]) g.tick(181 + QUICK.vote_seconds + 200);
    for (const p of [PLAYERS[0] as string, null, "mallory"]) {
      const a = delta(quiet.state, quiet.events, p, 0, { now: new Date(0) });
      const b = delta(busy.state, busy.events, p, 0, { now: new Date(0) });
      expect(b.seen).toBe(a.seen);
    }
  });

  it("another reader's cursor, a forged one or a stale one never shows another's events", () => {
    const { g, insiders } = played();
    const outsider = PLAYERS[4] as string;
    const own = view(g.state, g.events, outsider);
    const insider = insiders[0] as string;
    const theirs = sealCursor(scope(insider), 2);
    for (const cursor of [
      theirs,
      "",
      "3",
      `${theirs}x`,
      sealCursor(cursorScope("mafia", ID, outsider), 2),
      sealCursor(cursorScope("dinner", "m_anothermatch", outsider), 2),
      sealCursor(scope(null), 2),
    ]) {
      const r = delta(
        g.state,
        g.events,
        outsider,
        openCursor(scope(outsider), cursor),
      );
      expect("resync" in r.view && r.view.resync).toBe(true);
      expect(JSON.stringify(r.view)).not.toContain(SECRET);
      expect(JSON.stringify(r.view)).toBe(
        JSON.stringify({ ...own, resync: true }),
      );
    }
    // Any count at all, even one read off another's cursor in the clear,
    // indexes the reader's own list.
    for (let n = 0; n < 30; n++)
      expect(
        JSON.stringify(delta(g.state, g.events, outsider, n).view),
      ).not.toContain(SECRET);
  });

  it("after dinner keeps the reader's own list, with the result", () => {
    const { g } = played();
    const p = PLAYERS[0] as string;
    const before = delta(g.state, g.events, p, 0);
    g.tick(g.served());
    expect(g.state.phase).toBe("over");
    const after = changes(g.state, g.events, p, before.seen).view;
    expect(after.events.map((e) => e.kind)).toEqual(["served"]);
    expect(after.result).not.toBeNull();
    // Served says which open motions dinner voided, as the result does.
    expect(after.events[0]).toMatchObject({
      kind: "served",
      void: after.result?.void,
    });
    // The whole read now shows everything, the private word included.
    expect(JSON.stringify(view(g.state, g.events, p))).toContain(SECRET);
    expect(JSON.stringify(after)).not.toContain(SECRET);
  });
});
