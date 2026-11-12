import { cursorScope, openCursor, sealCursor } from "@unprompted-tables/server";
import { describe, expect, it } from "vitest";
import { act, apply, delta, type MatchEvent, replay, view } from "./match";
import { dealt, simulate } from "./read-cost";
import type { Rules } from "./settings";
import { present } from "./store";

// The delta read and its cursor. The cursor counts only the events a seat
// can see, so a seat's reads never step over, or measure, the private
// events of others (night talk, other seats' roles), and it is sealed to
// one seat of one match, so another seat's cursor, another match's or a
// forged one gives a resync of the reader's own view, never someone
// else's. A stale but genuine cursor gives everything since it was issued.

const seven = ["ada", "bea", "cal", "dot", "eve", "fay", "gus"];
const MAFIA = ["ada", "bea"];
const VILLAGE = seven.filter((p) => !MAFIA.includes(p));
const rules: Rules = {
  players: 7,
  reveal_on_death: true,
  talk_seconds: 60,
  vote_seconds: 60,
  max_days: 5,
};
const SECRET = "the-night-plan-is-cal";
const scope = (p: string | null) => cursorScope("mafia", "m_simulatedmatc", p);

// Day 1 to night 1's vote, with the mafia talking at night `nightTalk`
// times. Everything public is the same whatever nightTalk is.
function toNight(nightTalk: number) {
  const { log, at } = dealt(seven, rules, MAFIA);
  let s = replay("m_simulatedmatc", log);
  const add = (es: MatchEvent[]) => {
    log.push(...es);
    s = es.reduce(apply, s);
  };
  add(act(s, "cal", { turn: 1, kind: "talk", text: "good morning" }, at));
  for (const p of seven) add(act(s, p, { turn: 1, kind: "ready" }, at));
  for (const p of seven)
    add(act(s, p, { turn: 2, kind: "vote", target: null }, at));
  for (let i = 0; i < nightTalk; i++)
    add(
      act(
        s,
        MAFIA[i % 2] as string,
        { turn: 3, kind: "talk", text: `${SECRET} ${i}` },
        at,
      ),
    );
  return {
    get s() {
      return s;
    },
    log,
    add,
    at,
  };
}

// The same match played the same way in public, with the mafia dealt to
// different seats: at each step, the village seats' answers are taken.
// Night talk and night votes happen in both worlds, by whoever the mafia
// are, so only what a village seat must not learn differs.
function twin(mafia: string[]) {
  const { log, at } = dealt(seven, rules, mafia);
  let s = replay("m_simulatedmatc", log);
  const add = (es: MatchEvent[]) => {
    log.push(...es);
    s = es.reduce(apply, s);
  };
  const steps: { phase: string; s: typeof s; log: MatchEvent[] }[] = [];
  const snap = () => steps.push({ phase: s.phase, s, log: [...log] });
  snap();
  add(act(s, "cal", { turn: 1, kind: "talk", text: "good morning" }, at));
  for (const p of seven) add(act(s, p, { turn: 1, kind: "ready" }, at));
  snap();
  add(act(s, "fay", { turn: 2, kind: "vote", target: null }, at));
  snap();
  for (const p of seven.filter((p) => p !== "fay"))
    add(act(s, p, { turn: 2, kind: "vote", target: null }, at));
  snap();
  add(act(s, mafia[0] as string, { turn: 3, kind: "talk", text: "psst" }, at));
  snap();
  for (const p of mafia) add(act(s, p, { turn: 3, kind: "ready" }, at));
  snap();
  add(act(s, mafia[0] as string, { turn: 4, kind: "vote", target: "gus" }, at));
  snap();
  add(act(s, mafia[1] as string, { turn: 4, kind: "vote", target: "gus" }, at));
  snap();
  return steps;
}

describe("Mafia delta reads", () => {
  it("join up: a seat's deltas, in any split, are its whole view once", () => {
    const g = toNight(3);
    for (const p of [...seven, null]) {
      const whole = view(g.s, g.log, p).events;
      for (let n = 1; n <= g.log.length; n++) {
        const s0 = replay("m_simulatedmatc", g.log.slice(0, n));
        const first = delta(s0, g.log.slice(0, n), p, null);
        const rest = delta(g.s, g.log, p, first.seen);
        expect(rest.view.resync).toBeUndefined();
        expect([...first.view.events, ...rest.view.events]).toEqual(whole);
      }
    }
  });

  it("a village seat's count and deltas don't move with the night's talk", () => {
    const quiet = toNight(0);
    const busy = toNight(6);
    for (const p of [...VILLAGE, null]) {
      const a = delta(quiet.s, quiet.log, p, 0);
      const b = delta(busy.s, busy.log, p, 0);
      expect(b.seen).toBe(a.seen);
      expect(JSON.stringify(b.view)).toBe(JSON.stringify(a.view));
      expect(JSON.stringify(b.view)).not.toContain(SECRET);
    }
    // The mafia, who can see the night, are shown it.
    for (const p of MAFIA) {
      expect(delta(busy.s, busy.log, p, 0).seen).toBe(
        delta(quiet.s, quiet.log, p, 0).seen + 6,
      );
    }
  });

  it("a village seat's whole answer is the same whoever the mafia are", () => {
    const a = twin(["ada", "bea"]);
    const b = twin(["dot", "eve"]);
    expect(a.map((x) => x.phase)).toEqual([
      "day_talk",
      "day_vote",
      "day_vote",
      "night_talk",
      "night_talk",
      "night_vote",
      "night_vote",
      "day_talk",
    ]);
    expect(b.map((x) => x.phase)).toEqual(a.map((x) => x.phase));
    for (const [i, x] of a.entries()) {
      const y = b[i] as (typeof b)[number];
      for (const p of ["cal", "fay", "gus", null, "stranger"]) {
        const same = (f: (w: typeof x) => unknown) =>
          expect(JSON.stringify(f(y))).toBe(JSON.stringify(f(x)));
        same((w) => view(w.s, w.log, p));
        for (const after of [null, 0, 2, 5])
          same((w) => delta(w.s, w.log, p, after));
        const cursor = present(x.s, x.log, p, undefined).next;
        expect(present(y.s, y.log, p, cursor).events).toEqual(
          present(x.s, x.log, p, cursor).events,
        );
      }
    }
  });

  it("binds a cursor to its match: the same seat's cursor elsewhere resyncs", () => {
    const g = toNight(2);
    const other = { ...g.s, id: "m_anothermatchx" };
    for (const p of [...seven, null]) {
      const whole = present(g.s, g.log, p, undefined);
      expect(present(g.s, g.log, p, whole.next).events).toEqual([]);
      // The same events under another match's id: the same count would
      // slice them to nothing, so only the binding gives the resync.
      const elsewhere = present(other, g.log, p, whole.next);
      expect(elsewhere.resync).toBe(true);
      expect(elsewhere.events).toEqual(whole.events);
    }
  });

  it("a seat's cursor never reaches another seat's events", () => {
    const g = toNight(4);
    const villager = "cal";
    const own = view(g.s, g.log, villager).events;
    for (const mafioso of MAFIA) {
      // The mafia's cursor, from before the night, handed to a villager:
      // it doesn't open for the villager, who gets its own view again.
      const early = replay("m_simulatedmatc", g.log.slice(0, 9));
      const theirs = sealCursor(
        scope(mafioso),
        delta(early, g.log.slice(0, 9), mafioso, null).seen,
      );
      const count = openCursor(scope(villager), theirs);
      expect(count).toBeNull();
      const r = delta(g.s, g.log, villager, count);
      expect(r.view.resync).toBe(true);
      expect(r.view.events).toEqual(own);
      expect(JSON.stringify(r.view)).not.toContain(SECRET);
    }
    // Even an honest count taken from a mafia seat, used by a villager
    // (as if it had leaked in the clear), indexes the villager's own list.
    for (let n = 0; n <= 40; n++) {
      const r = delta(g.s, g.log, villager, n);
      expect(JSON.stringify(r.view)).not.toContain(SECRET);
      expect(r.view.you?.side).toBe("village");
      expect(r.view.you?.partners).toEqual([]);
    }
  });

  it("forged cursors resync the reader's own view; stale ones give what came since", () => {
    const g = toNight(4);
    const p = "dot";
    const own = view(g.s, g.log, p).events;
    const real = sealCursor(scope(p), 3);
    for (const forged of [
      "",
      "0",
      "1000",
      "c1.",
      `${real}x`,
      `c1.${"A".repeat(43)}`,
      real.replace(/.$/, real.endsWith("A") ? "B" : "A"),
      sealCursor(cursorScope("mafia", "m_othermatch00", p), 3),
      sealCursor(cursorScope("dinner", "m_simulatedmatc", p), 3),
      sealCursor(scope(null), 3),
    ]) {
      const r = delta(g.s, g.log, p, openCursor(scope(p), forged));
      expect(r.view.resync).toBe(true);
      expect(r.view.events).toEqual(own);
      expect(JSON.stringify(r.view)).not.toContain(SECRET);
    }
    // A stale but genuine cursor gives exactly what came after it.
    const r = delta(g.s, g.log, p, openCursor(scope(p), real));
    expect(r.view.resync).toBeUndefined();
    expect(r.view.events).toEqual(own.slice(3));
  });

  it("says what the seat may do, and nothing of other roles", () => {
    const g = toNight(0);
    // Night talk: the mafia may talk; villagers can't act.
    const m = delta(g.s, g.log, "ada", null).view.you;
    expect(m).toMatchObject({
      side: "mafia",
      partners: ["bea"],
      alive: true,
      can_act: true,
      moves: ["talk", "ready"],
      talks_left: 10,
    });
    const v = delta(g.s, g.log, "cal", null).view.you;
    expect(v).toEqual({
      player: "cal",
      side: "village",
      partners: [],
      alive: true,
      can_act: false,
    });
    expect(delta(g.s, g.log, null, null).view.you).toBeNull();
    expect(delta(g.s, g.log, "stranger", null).view.you).toBeNull();
    for (const p of MAFIA) g.add(act(g.s, p, { turn: 3, kind: "ready" }, g.at));
    // Night vote: targets are the living village, never a partner or self.
    expect(delta(g.s, g.log, "ada", null).view.you).toMatchObject({
      moves: ["vote"],
      targets: VILLAGE,
    });
    g.add(act(g.s, "ada", { turn: 4, kind: "vote", target: "cal" }, g.at));
    expect(delta(g.s, g.log, "ada", null).view.you?.can_act).toBe(false);
    g.add(act(g.s, "bea", { turn: 4, kind: "vote", target: "cal" }, g.at));
    // Day 2: cal is dead; the day vote's targets are everyone else alive.
    const dead = delta(g.s, g.log, "cal", null).view.you;
    expect(dead).toMatchObject({ alive: false, can_act: false });
    for (const p of g.s.alive)
      g.add(act(g.s, p, { turn: 5, kind: "ready" }, g.at));
    const day = delta(g.s, g.log, "dot", null).view.you;
    expect(day?.targets).toEqual(g.s.alive.filter((p) => p !== "dot"));
  });

  it("holds over a whole simulated match, for every seat at every read", () => {
    const r = simulate({
      players: seven,
      mafia: MAFIA,
      plan: ["cal", "dot", "ada", "eve", "bea"],
      nightTalk: () => 2,
    });
    expect(r.state.phase).toBe("over");
    // Every seat's deltas, joined, were exactly its own whole view, and
    // a village seat was never shown the night.
    for (const p of seven) {
      const reader = r.readers.get(p);
      const whole = view(r.state, r.events, p).events;
      expect(reader?.got).toEqual(whole);
      expect(openCursor(scope(p), reader?.cursor as string)).toBe(whole.length);
      if (VILLAGE.includes(p))
        expect(
          whole.some(
            (e) => e.kind === "talk" && e.untrusted_text.includes(" says "),
          ),
        ).toBe(true);
    }
    const night = r.events.filter((e) => e.audience !== "public");
    expect(night.length).toBeGreaterThan(seven.length);
    for (const p of VILLAGE)
      for (const e of night)
        if (e.audience !== "public" && !e.audience.includes(p))
          expect(r.readers.get(p)?.got).not.toContainEqual(e.body);
  });
});
