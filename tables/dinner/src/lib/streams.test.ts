import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  act,
  advance,
  apply,
  type MatchEvent,
  type MatchState,
  replay,
  start,
} from "./match";
import { rng, shuffle } from "./rng";
import { VARIANTS, type Variant } from "./variants";

// Each draw comes from its own stream of the party's own seed, so the guest
// list people see tells them nothing about the private feelings, and the
// seed itself comes from the system's randomness. Kept apart from
// match.test.ts because it watches rng and randomBytes.

const made: string[] = [];
vi.mock("./rng", async (original) => {
  const real = await original<typeof import("./rng")>();
  return {
    ...real,
    rng: (seed: string, stream: string) => {
      made.push(`${seed}/${stream}`);
      return real.rng(seed, stream);
    },
  };
});
vi.mock("node:crypto", async (original) => {
  const real = await original<typeof import("node:crypto")>();
  return { ...real, randomBytes: vi.fn(real.randomBytes) };
});

const players = ["alice", "bobby", "carol", "david", "ellen", "frank"];
const T0 = new Date("2026-11-10T03:00:00.000Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const quick = VARIANTS.quick as Variant;

const seedOf = (events: MatchEvent[]) =>
  (
    events.find((e) => e.body.kind === "deal")?.body as {
      deal: { seed: string };
    }
  ).deal.seed;

function tie(seed: string): MatchState {
  let state = replay("m_abcdefghijkl", start(players, quick, T0, seed));
  const step = (added: MatchEvent[]) => {
    state = added.reduce(apply, state);
  };
  const g = state.guests;
  step(act(state, "alice", { kind: "propose", seating: g }, later(1)));
  step(
    act(
      state,
      "bobby",
      { kind: "propose", seating: [g[1], g[0], ...g.slice(2)] as string[] },
      later(2),
    ),
  );
  step(advance(state, later(quick.talk_seconds)));
  return state;
}

describe("the party's draws", () => {
  it("takes each party's seed from the system's randomness", () => {
    const a = seedOf(start(players, quick, T0));
    const calls = vi.mocked(randomBytes).mock;
    expect(calls.calls.at(-1)).toEqual([16]);
    expect(a).toBe((calls.results.at(-1)?.value as Buffer).toString("hex"));
    expect(seedOf(start(players, quick, T0))).not.toBe(a);
  });

  it("draws guests, feelings and the fallback each from its own stream", () => {
    made.length = 0;
    const seed = "seed-under-test";
    const s = tie(seed);
    expect(s.end?.how).toBe("random");
    expect(new Set(made)).toEqual(
      new Set([`${seed}/guests`, `${seed}/feelings`, `${seed}/fallback`]),
    );
    // The first guest keeps the head of the table; the rest are drawn.
    const order = (s.end?.seating ?? []).map((n) => s.guests.indexOf(n));
    expect(order).toEqual([
      0,
      ...shuffle(rng(seed, "fallback"), [1, 2, 3, 4, 5]),
    ]);
  });
});
