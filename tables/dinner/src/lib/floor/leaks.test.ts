import { describe, expect, it } from "vitest";
import { floorFeed } from "./feed";
import {
  act,
  advance,
  apply,
  briefFor,
  EXECUTIVES,
  type FloorAction,
  type FloorDeal,
  type FloorEvent,
  type FloorState,
  nextDeadline,
  publicDue,
  replay,
  start,
  view,
} from "./game";
import { FEUD, ID, later, PLAYERS, SEATINGS, T0, TABLE } from "./test-harness";

// Twin worlds: two matches that differ only in what no reader may know
// before dinner (when dinner is served, and one executive's secret) must
// give every other reader, the public and a stranger byte-identical views,
// answers to seating questions, deadlines, schedules and feeds, at every
// second until the earlier dinner. The schedule is how a reader could time
// the end: a read that finds the clock has moved takes the match's lock.

type World = { events: FloorEvent[]; state: FloorState };
const mk = (events: FloorEvent[]): World => ({
  events,
  state: replay(ID, events),
});
function tick(w: World, at: Date): World {
  const late = advance(w.state, at);
  return late.length
    ? { events: [...w.events, ...late], state: late.reduce(apply, w.state) }
    : w;
}
function step(w0: World, player: string, action: FloorAction, at: Date) {
  const w = tick(w0, at);
  const added = act(w.state, player, action, at);
  return {
    events: [...w.events, ...added],
    state: added.reduce(apply, w.state),
  };
}

// The same match with dinner at another time and executive k's secret on
// someone else, chosen among those k shows no like for, so the public
// likes don't change.
function twin(events: FloorEvent[], k: number, served: number): FloorEvent[] {
  const deal = events.find((e) => e.body.kind === "deal")?.body as {
    deal: FloorDeal;
  };
  const d = deal.deal;
  const old = (d.secrets[k] as number[])[0] as number;
  const row = d.weights[k] as number[];
  const other = [0, 1, 2, 3, 4].find(
    (j) => j !== k && j !== old && row[j] === 0,
  );
  if (other === undefined) throw new Error("no other target");
  const weights = d.weights.map((r, i) =>
    i === k
      ? r.map((v, j) =>
          j === old ? 0 : j === other ? v + (row[old] as number) : v,
        )
      : r,
  );
  const secrets = d.secrets.map((s, i) => (i === k ? [other] : s));
  const next: FloorDeal = { ...d, weights, secrets, served_after: served };
  const state = replay(ID, events);
  return events.map((e) => {
    if (e.body.kind === "deal")
      return { ...e, body: { ...e.body, deal: next } };
    if (
      e.body.kind === "brief" &&
      state.cast[PLAYERS.indexOf(e.body.player)] === k
    )
      return {
        ...e,
        body: { ...e.body, ...briefFor(next, k, state.rules) },
      };
    return e;
  });
}

describe("twin worlds", () => {
  for (const seed of ["leak-1", "leak-2", "leak-3", "leak-4"])
    it(`show no reader when dinner comes or another's secret (${seed})`, () => {
      const base = start(PLAYERS, FEUD, T0, seed);
      const s0 = replay(ID, base);
      const d = s0.deal as FloorDeal;
      // The secret that differs is the first player's executive's... and
      // that player is left out of the readers.
      const k = s0.cast[0] as number;
      const t1 = d.served_after;
      const t2 = t1 === 1680 ? 1695 : 1680;
      // The window's ends are public; a moment inside it must never show.
      const hidden = [t1, t2].filter((t) => t !== 1500 && t !== 1860);
      let a = mk(base);
      let b = mk(twin(base, k, t2));
      expect(b.state.deal?.served_after).toBe(t2);
      expect(b.state.deal?.secrets[k]).not.toEqual(d.secrets[k]);
      const readers = [null, "mallory", ...PLAYERS.slice(1)];
      const earlier = Math.min(t1, t2);
      const ask = SEATINGS[7] as string[];
      const exec = (p: string) =>
        EXECUTIVES[s0.cast[PLAYERS.indexOf(p)] as number] as string;
      const others = (p: string) => EXECUTIVES.filter((x) => x !== exec(p));
      // A script that doesn't depend on any secret: talk, guesses, motions
      // that pass, fail and time out, one every so often.
      const script: [number, string, FloorAction][] = [
        [5, PLAYERS[1] as string, { kind: "talk", text: "evening" }],
        [
          6,
          PLAYERS[0] as string,
          { kind: "talk", text: "psst", to: [exec(PLAYERS[2] as string)] },
        ],
        [
          7,
          PLAYERS[3] as string,
          {
            kind: "name",
            executive: others(PLAYERS[3] as string)[0] as string,
            dislikes: others(PLAYERS[3] as string)[1] as string,
          },
        ],
        [
          180,
          PLAYERS[2] as string,
          { kind: "motion", seating: SEATINGS[0] as string[] },
        ],
        [190, PLAYERS[0] as string, { kind: "vote", motion: 1, ballot: "yes" }],
        [
          200,
          PLAYERS[4] as string,
          { kind: "motion", seating: SEATINGS[1] as string[] },
        ],
        [210, PLAYERS[1] as string, { kind: "vote", motion: 1, ballot: "yes" }],
        [
          400,
          PLAYERS[3] as string,
          { kind: "motion", seating: SEATINGS[2] as string[] },
        ],
        [401, PLAYERS[1] as string, { kind: "vote", motion: 3, ballot: "no" }],
        [402, PLAYERS[0] as string, { kind: "vote", motion: 3, ballot: "no" }],
        [403, PLAYERS[4] as string, { kind: "vote", motion: 3, ballot: "no" }],
        [
          earlier - 2,
          PLAYERS[1] as string,
          { kind: "motion", seating: SEATINGS[3] as string[] },
        ],
      ];
      let compared = 0;
      const check = (sec: number) => {
        const now = later(sec);
        const la = advance(a.state, now).map((e) => JSON.stringify(e));
        const lb = advance(b.state, now).map((e) => JSON.stringify(e));
        expect(lb, `schedule at ${sec}`).toEqual(la);
        a = tick(a, now);
        b = tick(b, now);
        expect(publicDue(b.state)).toEqual(publicDue(a.state));
        expect(nextDeadline(b.state, now)).toEqual(nextDeadline(a.state, now));
        for (const who of readers) {
          const x = JSON.stringify(view(a.state, a.events, who, { now }));
          const y = JSON.stringify(view(b.state, b.events, who, { now }));
          expect(y, `${who} at ${sec}`).toBe(x);
          for (const t of hidden)
            expect(x).not.toContain(later(t).toISOString());
          compared++;
        }
        for (const who of PLAYERS.slice(1)) {
          const x = view(a.state, a.events, who, { now, ask }).asked;
          const y = view(b.state, b.events, who, { now, ask }).asked;
          expect(y).toEqual(x);
        }
        const fx = JSON.stringify(floorFeed(a.state, a.events, TABLE));
        const fy = JSON.stringify(floorFeed(b.state, b.events, TABLE));
        expect(fy, `feed at ${sec}`).toBe(fx);
        for (const t of hidden)
          expect(fx).not.toContain(later(t).toISOString());
        compared++;
      };
      let i = 0;
      for (let sec = 0; sec < earlier; sec += 1) {
        while (i < script.length && (script[i]?.[0] as number) <= sec) {
          const [at, who, action] = script[i] as [number, string, FloorAction];
          a = step(a, who, action, later(at));
          b = step(b, who, action, later(at));
          i++;
        }
        // Every second near the moves and dinner, and every ten otherwise.
        if (sec % 10 === 0 || sec > earlier - 30 || sec < 420) check(sec);
      }
      expect(i).toBe(script.length);
      expect(compared).toBeGreaterThan(1000);
      // Then the earlier dinner comes, in one world only.
      const ends = (w: World) => advance(w.state, later(earlier)).length;
      expect(t1 < t2 ? ends(a) : ends(b)).toBe(1);
      expect(t1 < t2 ? ends(b) : ends(a)).toBe(0);
    });
});
