import { div, num, type Q, q, str, sum } from "./fraction";
import {
  bargain,
  core,
  dominators,
  indexOfSeating,
  lotteryNash,
  maxmin,
  nash,
  nashProduct,
  paretoFrontier,
  paretoImprovements,
  predicted,
  type Table,
  table,
  utilitarian,
} from "./solver";

// The theory a finished match is measured against, computed once when it
// ends from the weights in its private deal, and kept in its end event.
// Fractions are kept as strings ("28/5"); seatings as lists of names in
// order round the table from the speaker. Everything here is about the
// briefs, which are revealed at the end; none of it is shown before.

export type Benchmarks = {
  best: number[];
  worst: number[];
  no_deal: number[];
  highest_total: number;
  // Leximin on each executive's share of their own best.
  // The lowest executive's points over the fairest seatings: lowest to
  // lowest_max when tied seatings differ (absent in matches ended before
  // it was kept, where the two are equal).
  fairest: { lowest: number; lowest_max?: number; seatings: string[][] };
  nash: { seatings: string[][]; points: string[]; lottery: string[] | null };
  pareto: { count: number; seatings: string[][] };
  core: {
    majority: number;
    four: number;
    unanimity: number;
    majority_seatings: string[][];
    fewest_majority_dominators: number;
  };
  // The agreed seating against the 60, or null after no deal.
  final: {
    pareto_improvements: number;
    majority_dominators: number;
    larger_nash: number;
  } | null;
  // The no-talk prediction (full information, backward induction, baseline
  // tie rules), walked with this match's own proposer draws.
  theory: {
    draws: string[];
    round: number | null;
    proposer: string | null;
    offers: string[][];
    yes: number[];
    own: number | null;
    expect: string[];
    proposer_share: string | null;
    firm: boolean;
    before_draw: string[];
    // For each round played, what theory had its actual proposer do.
    rounds: {
      round: number;
      proposer: string;
      passes: boolean;
      own: number | null;
      offers: string[][];
      expect: string[];
    }[];
  };
};

const MAX_LISTED = 6;

export function benchmarks(opts: {
  names: readonly string[];
  weights: number[][];
  margin: number;
  need: number;
  rounds: number;
  draws: number[];
  played: number[]; // the proposer of each round played
  final: number[] | null; // the agreed order, or null after no deal
}): Benchmarks {
  const t: Table = table(opts.weights, opts.margin);
  const spell = (x: number) =>
    (t.seatings[x] as number[]).map((i) => opts.names[i] as string);
  const list = (xs: number[]) => xs.map(spell);
  const ut = utilitarian(t);
  const fair = maxmin(t);
  const nb = nash(t);
  const nashPoints = Array.from({ length: t.n }, (_, i) =>
    str(
      q(
        nb.seatings.reduce(
          (s, x) => s + ((t.points[x] as number[])[i] as number),
          0,
        ),
        nb.seatings.length,
      ),
    ),
  );
  const front = paretoFrontier(t);
  const maj = dominators(t, 3);
  const coreMaj = core(t, 3);
  const plan = bargain(t, opts.need, opts.rounds);
  const p = predicted(plan, opts.draws);
  const total = (x: number) =>
    (t.points[x] as number[]).reduce((a, b) => a + b, 0);
  let share: Q | null = null;
  // No share of nothing: a seating where nobody scores has no split.
  const offers = p?.cell.offers ?? [];
  if (p && offers.length > 0 && offers.every((x) => total(x) > 0)) {
    const own = p.cell.own as number;
    share = div(
      sum(p.cell.offers.map((x) => q(own, total(x)))),
      q(p.cell.offers.length),
    );
  }
  let final: Benchmarks["final"] = null;
  if (opts.final) {
    const x = indexOfSeating(t, opts.final);
    const mine = nashProduct(t, x);
    final = {
      pareto_improvements: paretoImprovements(t, x),
      majority_dominators: maj[x] as number,
      larger_nash: t.seatings.filter((_, y) => nashProduct(t, y) > mine).length,
    };
  }
  return {
    best: t.best,
    worst: t.worst,
    no_deal: t.noDeal,
    highest_total: ut.total,
    fairest: {
      lowest: fair.lowest,
      lowest_max: fair.lowest_max,
      seatings: list(fair.seatings),
    },
    nash: {
      seatings: list(nb.seatings),
      points: nashPoints,
      lottery: lotteryNash(t, nb.seatings)?.map(str) ?? null,
    },
    pareto: {
      count: front.length,
      seatings: front.length <= MAX_LISTED ? list(front) : [],
    },
    core: {
      majority: coreMaj.length,
      four: core(t, 4).length,
      unanimity: core(t, 5).length,
      majority_seatings: coreMaj.length <= 4 ? list(coreMaj) : [],
      fewest_majority_dominators: Math.min(...maj),
    },
    final,
    theory: {
      draws: opts.draws.map((i) => opts.names[i] as string),
      round: p?.round ?? null,
      proposer: p ? (opts.names[p.proposer] as string) : null,
      offers: p ? list(p.cell.offers) : [],
      yes: p ? p.cell.yes.map((y) => y.length) : [],
      own: p?.cell.own ?? null,
      expect: p ? p.cell.expect.map(str) : t.noDeal.map((v) => `${v}`),
      proposer_share: share ? str(share) : null,
      firm: p?.cell.firm ?? true,
      before_draw: (plan[0]?.value ?? []).map(str),
      rounds: opts.played.map((who, k) => {
        const cell = plan[k]?.by[who];
        return {
          round: k + 1,
          proposer: opts.names[who] as string,
          passes: cell?.passes ?? false,
          own: cell?.own ?? null,
          offers: cell ? list(cell.offers) : [],
          expect: (cell?.expect ?? []).map(str),
        };
      }),
    },
  };
}

// "28/5" to 5.6, for display.
export function value(fraction: string): number {
  const [n, d = "1"] = fraction.split("/");
  return num(q(BigInt(n as string), BigInt(d)));
}
