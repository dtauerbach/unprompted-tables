import { describe, expect, it } from "vitest";
import raw from "./fixtures/benchmarks.json";
import { add, cmp, q, str } from "./fraction";
import {
  agreementRounds,
  allSeatings,
  bargain,
  canonicalOrder,
  core,
  dominators,
  fairGap,
  lotteryNash,
  maxmin,
  nash,
  paretoFrontier,
  paretoImprovements,
  predicted,
  type Tie,
  table,
  totalGap,
  utilitarian,
} from "./solver";

// The TypeScript port against the reference solver's exact output
// (benchmarks.py in the design; fixtures/benchmarks.json is what it wrote).
// Every number, list and fraction must match, for every configuration and
// for 2, 3 and 4 rounds.

type Config = {
  id: string;
  q: number;
  weights: Record<string, Record<string, number>>;
  best: number[];
  worst: number[];
  no_deal: number[];
  points: Record<string, number[]>;
  pareto: string[];
  utilitarian: { total: number; seatings: string[] };
  maxmin: { lowest: number; seatings: string[] };
  nash: { product: number; seatings: string[]; lottery: string[] | null };
  core: Record<string, string[]>;
  majority_dominators: Record<string, number>;
  conflict: { fair_gap: string; total_gap: string };
  bargain: Record<string, unknown>;
};
const fixture = raw as unknown as {
  margin: number;
  execs: string;
  seatings: string[];
  configs: Config[];
};

const LETTERS = fixture.execs; // "ABCDE"
const spell = (seating: number[]) =>
  seating.map((i) => LETTERS[i] as string).join("");

function weightsOf(c: Config): number[][] {
  const w = c.weights;
  return [...LETTERS].map((e) => [...LETTERS, "S"].map((k) => w[e]?.[k] ?? 0));
}

describe("exact fractions", () => {
  it("adds, compares and spells like Python's Fraction", () => {
    expect(str(add(q(1, 3), q(1, 6)))).toBe("1/2");
    expect(str(q(-20, 2))).toBe("-10");
    expect(str(q(28, 5))).toBe("28/5");
    expect(str(q(3, -6))).toBe("-1/2");
    expect(cmp(q(7), q(14, 2))).toBe(0);
    expect(cmp(q(34, 5), q(7))).toBeLessThan(0);
    expect(() => q(1, 0)).toThrow();
  });
});

describe("seatings", () => {
  it("lists the 60 seatings in the reference order", () => {
    expect(allSeatings(5).map(spell)).toEqual(fixture.seatings);
    expect(spell(canonicalOrder([2, 4, 1, 3, 0]))).toBe("ADBEC");
  });
});

describe.each(
  fixture.configs.map((c) => [c.id, c] as const),
)("the %s configuration", (_id, c) => {
  const t = table(weightsOf(c), fixture.margin);
  const names = (xs: number[]) =>
    xs.map((x) => spell(t.seatings[x] as number[]));

  it("scores every seating", () => {
    const got = Object.fromEntries(
      t.seatings.map((x, k) => [spell(x), t.points[k]]),
    );
    expect(got).toEqual(c.points);
    expect(t.best).toEqual(c.best);
    expect(t.worst).toEqual(c.worst);
    expect(t.noDeal).toEqual(c.no_deal);
  });

  it("finds the same yardsticks", () => {
    expect(names(paretoFrontier(t)).sort()).toEqual(c.pareto);
    const u = utilitarian(t);
    expect({ total: u.total, seatings: names(u.seatings) }).toEqual(
      c.utilitarian,
    );
    const m = maxmin(t);
    expect({ lowest: m.lowest, seatings: names(m.seatings) }).toEqual(c.maxmin);
    const n = nash(t);
    expect(Number(n.product)).toBe(c.nash.product);
    expect(names(n.seatings)).toEqual(c.nash.seatings);
    expect(lotteryNash(t, n.seatings)?.map(str) ?? null).toEqual(
      c.nash.lottery,
    );
    expect(str(fairGap(t))).toBe(c.conflict.fair_gap);
    expect(str(totalGap(t))).toBe(c.conflict.total_gap);
  });

  it("finds the same core under each rule", () => {
    for (const k of [3, 4, 5])
      expect(names(core(t, k))).toEqual(c.core[String(k)]);
    const d = dominators(t, 3);
    expect(
      Object.fromEntries(t.seatings.map((x, k) => [spell(x), d[k]])),
    ).toEqual(c.majority_dominators);
  });

  it.each(Object.keys(c.bargain))("predicts %s round by round", (key) => {
    const [, need, rounds, tie] = key.match(
      /^q(\d)_rounds(\d)_([a-z]+)$/,
    ) as string[];
    const plan = bargain(t, Number(need), Number(rounds), tie as Tie);
    const want = c.bargain[key];
    expect(
      plan.map((r) => ({
        round: r.round,
        go_on: r.goOn.map(str),
        value: r.value.map(str),
        by: Object.fromEntries(
          r.by.map((cell, p) => [
            LETTERS[p],
            {
              passes: cell.passes,
              own: cell.own,
              offers: names(cell.offers),
              yes: cell.yes.map(spell),
              firm: cell.firm,
              expect: cell.expect.map(str),
            },
          ]),
        ),
      })),
    ).toEqual(want);
  });
});

describe("what the design says of the prediction", () => {
  const byId = (id: string) => {
    const c = fixture.configs.find((x) => x.id === id) as Config;
    return { c, t: table(weightsOf(c), fixture.margin) };
  };

  it("takes the first round whose drawn proposer has a passing offer", () => {
    const { t } = byId("standoff");
    const plan = bargain(t, 5, 3);
    // Rounds 1 and 2 fail whoever is drawn; in round 3 Blake takes the seat.
    const p = predicted(plan, [0, 3, 1]);
    expect(p?.round).toBe(3);
    expect(p?.proposer).toBe(1);
    expect(p?.cell.offers.map((x) => spell(t.seatings[x] as number[]))).toEqual(
      ["BEDAC"],
    );
    expect(agreementRounds(plan).rounds.map(str)).toEqual(["0", "0", "1"]);
    // Casey, Devon or Emery pick either rival evenly.
    expect(predicted(plan, [2, 2, 2])?.cell.expect.map(str)).toEqual([
      "7",
      "7",
      "10",
      "10",
      "10",
    ]);
  });

  it("deals the compromise in round 1 and the scramble 3-2", () => {
    const { t } = byId("compromise");
    const p = predicted(bargain(t, 5, 3), [3, 0, 0]);
    expect(p?.round).toBe(1);
    expect(spell(t.seatings[p?.cell.offers[0] as number] as number[])).toBe(
      "ABCDE",
    );
    const s = byId("scramble").t;
    const sp = predicted(bargain(s, 3, 3), [0, 1, 2]);
    expect(sp?.round).toBe(1);
    expect(sp?.cell.yes.every((y) => y.length === 3)).toBe(true);
    expect(sp?.cell.own).toBe(10);
  });

  it("counts seatings better for some and worse for none", () => {
    const { t } = byId("standoff");
    const idx = (s: string) => t.seatings.findIndex((x) => spell(x) === s);
    expect(paretoImprovements(t, idx("ADEBC"))).toBe(0);
    expect(paretoImprovements(t, idx("ABCDE"))).toBeGreaterThan(0);
  });
});
