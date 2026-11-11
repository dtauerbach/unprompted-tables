import { allSeatings } from "../exec/solver";
import { floorFeed } from "./feed";
import {
  act,
  advance,
  apply,
  EXECUTIVES,
  type FloorAction,
  type FloorEvent,
  type FloorState,
  playerOf,
  replay,
  start,
  view,
} from "./game";
import { FLOOR_VARIANTS, type FloorVariant } from "./variants";

// A match driven in memory, for the floor's tests: the clock is seconds
// after T0, and every move runs the clock first, as the store does.

export const PLAYERS = ["alice", "bobby", "carol", "david", "ellen"];
export const T0 = new Date("2026-11-10T03:00:00.000Z");
export const later = (s: number) => new Date(T0.getTime() + s * 1000);
export const ID = "m_abcdefghijkl";
export const TABLE = { name: "Dinner party", game: "dinner-party" };
export const FEUD = FLOOR_VARIANTS.feud as FloorVariant;
export const QUICK = FLOOR_VARIANTS["quick-feud"] as FloorVariant;
// No dealt variant scores guesses; the engine still can, so its tests use
// feud with the old scored naming.
export const SCORED: FloorVariant = {
  ...FEUD,
  naming: { right: 2, wrong: -1, exposed: -2 },
};

// Distinct seatings, by name, in a fixed order.
export const SEATINGS: string[][] = allSeatings(5).map((s) =>
  s.map((i) => EXECUTIVES[i] as string),
);

export const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "ok";
};

export function floorMatch(
  variant: FloorVariant = FEUD,
  seed = "seed-1",
  players = PLAYERS,
) {
  let events: FloorEvent[] = start(players, variant, T0, seed);
  let state: FloorState = replay(ID, events);
  const g = {
    get state(): FloorState {
      return state;
    },
    get events(): FloorEvent[] {
      return events;
    },
    // Runs the clock to `at` seconds.
    tick(at: number): FloorEvent[] {
      const added = advance(state, later(at));
      events = [...events, ...added];
      state = added.reduce(apply, state);
      return added;
    },
    run(player: string, action: FloorAction, at: number): FloorEvent[] {
      g.tick(at);
      const added = act(state, player, action, later(at));
      events = [...events, ...added];
      state = added.reduce(apply, state);
      return added;
    },
    // The player who plays for an executive.
    of: (executive: string) => playerOf(state, EXECUTIVES.indexOf(executive)),
    move(executive: string, seating: string[], at: number) {
      return g.run(g.of(executive), { kind: "motion", seating }, at);
    },
    vote(executive: string, motion: number, ballot: "yes" | "no", at: number) {
      return g.run(g.of(executive), { kind: "vote", motion, ballot }, at);
    },
    guess(executive: string, x: string, y: string, at: number) {
      return g.run(
        g.of(executive),
        { kind: "name", executive: x, dislikes: y },
        at,
      );
    },
    talk(executive: string, text: string, at: number, to?: string[]) {
      return g.run(
        g.of(executive),
        { kind: "talk", text, ...(to ? { to } : {}) },
        at,
      );
    },
    code(f: () => unknown) {
      return codeOf(f);
    },
    view(player: string | null, at: number, ask?: string[]) {
      return view(state, events, player, { now: later(at), ask });
    },
    feed() {
      return floorFeed(state, events, TABLE);
    },
    // When dinner is served, in seconds after T0. Tests only.
    served: () => state.deal?.served_after as number,
  };
  return g;
}

// A seed whose secrets and served time suit a test.
export function seedWhere(
  ok: (g: ReturnType<typeof floorMatch>) => boolean,
  variant: FloorVariant = FEUD,
): string {
  for (let i = 0; i < 2000; i++) {
    const seed = `search-${i}`;
    if (ok(floorMatch(variant, seed))) return seed;
  }
  throw new Error("no seed");
}
