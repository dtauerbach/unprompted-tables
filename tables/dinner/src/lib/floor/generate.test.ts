import { describe, expect, it } from "vitest";
import { rng } from "../rng";
import {
  castFor,
  checkDeal,
  type Deal,
  dealFor,
  draw,
  LEVEL_DEALS,
  MAX_TRIES,
  servedAfter,
} from "./generate";
import {
  FLOOR_VARIANTS,
  type FloorVariant,
  LEVELS,
  type Level,
} from "./variants";

// The generator's promises, checked by a brute force of the test's own
// that shares no code with generate.ts: over every one of the 60 seatings,
// for hundreds of seeds at every level.

const SEEDS = 500;

// Every seating of the five round the speaker (5), up to reflection.
function seatings(): number[][] {
  const out: number[][] = [];
  const go = (rest: number[], acc: number[]) => {
    if (!rest.length) {
      if ((acc[0] as number) < (acc[4] as number)) out.push(acc);
      return;
    }
    rest.forEach((x, k) => {
      go([...rest.slice(0, k), ...rest.slice(k + 1)], [...acc, x]);
    });
  };
  go([0, 1, 2, 3, 4], []);
  return out;
}
const ALL = seatings();

function pointsIn(W: number[][], s: number[]): number[] {
  const ring = [5, ...s];
  const out = [0, 0, 0, 0, 0];
  for (let k = 1; k < 6; k++) {
    const i = ring[k] as number;
    const row = W[i] as number[];
    out[i] =
      (row[ring[k - 1] as number] as number) +
      (row[ring[(k + 1) % 6] as number] as number);
  }
  return out;
}
const table = (W: number[][]) => ALL.map((s) => pointsIn(W, s));
const prefer = (P: number[][], y: number, x: number) =>
  (P[y] as number[]).filter((v, i) => v > ((P[x] as number[])[i] as number))
    .length >= 3;
const unbeaten = (P: number[][]) =>
  ALL.filter((_, x) => !ALL.some((_s, y) => y !== x && prefer(P, y, x))).length;
const zeroed = (W: number[][], sec: number[][], only?: number) =>
  W.map((row, i) =>
    row.map((v, j) =>
      (only === undefined || only === i) && (sec[i] as number[]).includes(j)
        ? 0
        : v,
    ),
  );

// Every promise the design makes of a deal, from scratch.
function verify(d: Deal, level: Level) {
  const L = LEVEL_DEALS[level];
  const W = d.weights;
  const P = table(W);
  const best = [0, 1, 2, 3, 4].map((i) =>
    Math.max(...P.map((u) => u[i] as number)),
  );
  const worst = [0, 1, 2, 3, 4].map((i) =>
    Math.min(...P.map((u) => u[i] as number)),
  );
  // Shape: one big like each, round a ring of all five; one small like;
  // a speaker value from the level's list; the secrets where they say.
  const big = W.map((row) => row.slice(0, 5).indexOf(L.likes[0]));
  expect(new Set(big).size).toBe(5);
  let at = 0;
  for (let k = 0; k < 5; k++) at = big[at] as number;
  expect(at).toBe(0);
  for (let k = 1; k < 5; k++) {
    at = big[at] as number;
    if (at === 0) expect.fail("big likes must form one ring of five");
  }
  W.forEach((row, i) => {
    expect(row[i]).toBe(0);
    expect(row.slice(0, 5).filter((v) => v === L.likes[1])).toHaveLength(1);
  });
  expect(W.map((row) => row[5]).sort()).toEqual([...L.speaker].sort());
  expect(d.secrets.filter((x) => x.length).length).toBe(L.holders);
  d.secrets.forEach((sec, i) => {
    if (!sec.length) return;
    expect(sec.map((j) => (W[i] as number[])[j])).toEqual(L.dislikes);
    for (const j of sec) expect(j).not.toBe(i);
  });
  // No other negative entries: the secrets are the only dislikes.
  const negatives = W.flatMap((row, i) =>
    row.flatMap((v, j) => (v < 0 ? [[i, j]] : [])),
  );
  expect(negatives).toHaveLength(d.secrets.flat().length);
  // Empty core: every seating has a challenger three strictly prefer.
  expect(unbeaten(P)).toBe(0);
  // Someone always loses.
  for (const u of P)
    expect(
      Math.min(
        ...u.map(
          (v, i) =>
            (v - (worst[i] as number)) /
            ((best[i] as number) - (worst[i] as number)),
        ),
      ),
    ).toBeLessThanOrEqual(0.5);
  // Public calm: without the secrets some seating is unbeaten.
  const Wp = zeroed(W, d.secrets);
  const Pp = table(Wp);
  expect(unbeaten(Pp)).toBeGreaterThan(0);
  // The obvious seating is poisoned.
  const totals = Pp.map((u) => u.reduce((a, b) => a + b, 0));
  const top = Math.max(...totals);
  for (const [x, s] of ALL.entries()) {
    if (totals[x] !== top) continue;
    const ring = [5, ...s];
    let beside = 0;
    for (let k = 1; k < 6; k++) {
      const i = ring[k] as number;
      const sec = d.secrets[i] as number[];
      if (
        sec.includes(ring[k - 1] as number) ||
        sec.includes(ring[(k + 1) % 6] as number)
      )
        beside++;
    }
    expect(beside).toBeGreaterThanOrEqual(L.poisoned);
  }
  // Each secret matters to at least 2 percent of the 3,540 comparisons.
  for (let i = 0; i < 5; i++) {
    if (!(d.secrets[i] as number[]).length) continue;
    const Pi = table(zeroed(W, d.secrets, i));
    let flips = 0;
    for (let x = 0; x < 60; x++)
      for (let y = 0; y < 60; y++)
        if (x !== y && prefer(P, y, x) !== prefer(Pi, y, x)) flips++;
    expect(flips / 3540).toBeGreaterThanOrEqual(0.02);
  }
  // Unrequited secrets, as many as the level asks.
  const unrequited = d.secrets.filter(
    (sec, i) =>
      sec.length && ((W[sec[0] as number] as number[])[i] as number) > 0,
  ).length;
  expect(unrequited).toBeGreaterThanOrEqual(L.unrequited);
  // No deal is below every executive's worst seating.
  for (const w of worst) expect(w - 3).toBeLessThan(w);
}

describe("the open floor's deals", () => {
  expect(ALL).toHaveLength(60);

  for (const level of LEVELS)
    it(`keeps every promise at ${level}, for ${SEEDS} seeds`, () => {
      let tries = 0;
      for (let s = 0; s < SEEDS; s++) {
        const d = dealFor(`seed-${level}-${s}`, level);
        verify(d, level);
        tries += d.tries;
      }
      // Cheap enough to redraw: a few to a few dozen draws on average.
      expect(tries / SEEDS).toBeLessThan(30);
    });

  it("deals the same table from the same seed, and another from another", () => {
    const a = dealFor("same", "feud");
    expect(dealFor("same", "feud")).toEqual(a);
    expect(dealFor("other", "feud")).not.toEqual(a);
    expect(castFor("same")).toEqual(castFor("same"));
    expect([...castFor("same")].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("fails loudly once the draws run out, rather than deal a table that settles", () => {
    // A seed whose first draw fails the checks.
    let seed = 0;
    while (
      checkDeal(
        draw(rng(`cap-${seed}`, "deal"), LEVEL_DEALS.feud),
        LEVEL_DEALS.feud,
      ).ok
    )
      seed++;
    expect(() => dealFor(`cap-${seed}`, "feud", { tries: 1 })).toThrow(
      /no feud deal passed the checks in 1 draws/,
    );
    expect(MAX_TRIES).toBe(500);
  });

  it("says which check a draw failed", () => {
    const fails = new Set<string>();
    const r = rng("fails", "deal");
    for (let k = 0; k < 400; k++) {
      const c = checkDeal(draw(r, LEVEL_DEALS.feud), LEVEL_DEALS.feud);
      expect(c.ok).toBe(c.failed === null);
      if (c.failed) fails.add(c.failed);
    }
    expect(fails.has("empty_core")).toBe(true);
    expect(fails.has("someone_loses")).toBe(true);
    // A margin of nothing is no deal at all.
    const d = dealFor("margin", "feud");
    expect(checkDeal(d, LEVEL_DEALS.feud, 0)).toEqual({
      ok: false,
      failed: "no_deal",
    });
  });

  it("serves dinner at any second of the window, from a stream of its own", () => {
    for (const v of Object.values(FLOOR_VARIANTS))
      expect(v.served.step).toBe(1);
    const w = (FLOOR_VARIANTS.feud as FloorVariant).served;
    expect(w).toEqual({ from: 1500, to: 1860, step: 1 });
    const seen = new Set<number>();
    for (let s = 0; s < 4000; s++) {
      const t = servedAfter(`served-${s}`, w);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(1500);
      expect(t).toBeLessThanOrEqual(1860);
      seen.add(t);
    }
    // Not confined to a grid: no step coarser than a second holds every
    // moment drawn, and nearly all 361 seconds come up.
    for (const step of [2, 3, 5, 10, 15, 30, 60])
      expect([...seen].every((t) => (t - 1500) % step === 0)).toBe(false);
    expect(seen.size).toBeGreaterThan(340);
    const gaps = [...seen]
      .sort((a, b) => a - b)
      .map((t, k, a) => t - (a[k - 1] ?? t));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5);
    // The deal's stream doesn't move the served time, nor the other way.
    expect(servedAfter("x", w)).toBe(servedAfter("x", w));
    expect(dealFor("x", "feud")).toEqual(dealFor("x", "feud"));
  });

  it("still draws an old grid's steps when a window asks for them", () => {
    const w = { from: 1500, to: 1860, step: 15 };
    const seen = new Set<number>();
    for (let s = 0; s < 2000; s++) {
      const t = servedAfter(`served-${s}`, w);
      expect((t - 1500) % 15).toBe(0);
      seen.add(t);
    }
    expect(seen.size).toBe(25);
  });
});
