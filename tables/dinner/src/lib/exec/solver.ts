import { add, cmp, div, type Q, q, sub, sum, ZERO } from "./fraction";

// Exact benchmarks for the executive seating game, a port of the design's
// benchmarks.py and tested against its output (fixtures/benchmarks.json).
//
// Executives are numbered 0..n-1 and the keynote speaker is n. A seating is
// the order of the executives going round the table from the speaker; going
// round the other way gives everyone the same two neighbours, so a seating
// and its reverse are one seating, spelt by the lexicographically smaller.
// An executive's points are their weight for one neighbour plus their weight
// for the other. Every seating is enumerated and every comparison is exact.

export type Weights = number[][]; // weights[i][j]: i's points for j beside them
export type Tie = "generous" | "even" | "harsh";
export type Lean = "yes" | "no";

export type Table = {
  n: number;
  seatings: number[][];
  // points[x][i]: executive i's points in seating x.
  points: number[][];
  best: number[];
  worst: number[];
  // What each executive gets if nothing passes: worst possible minus margin.
  noDeal: number[];
};

const before = (a: readonly number[], b: readonly number[]): number => {
  for (let k = 0; k < a.length; k++)
    if (a[k] !== b[k]) return (a[k] as number) - (b[k] as number);
  return 0;
};

export function canonicalOrder(order: readonly number[]): number[] {
  const back = [...order].reverse();
  return before(order, back) <= 0 ? [...order] : back;
}

function permutations(xs: number[]): number[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

// Every distinct seating of n executives round the speaker, in order.
export function allSeatings(n: number): number[][] {
  const seen = new Map<string, number[]>();
  for (const p of permutations(Array.from({ length: n }, (_, i) => i))) {
    const c = canonicalOrder(p);
    seen.set(c.join(","), c);
  }
  return [...seen.values()].sort(before);
}

export function pointsOf(
  weights: Weights,
  seating: readonly number[],
): number[] {
  const n = seating.length;
  const ring = [n, ...seating];
  const out = new Array<number>(n).fill(0);
  ring.forEach((who, k) => {
    if (who === n) return;
    const left = ring[(k + ring.length - 1) % ring.length] as number;
    const right = ring[(k + 1) % ring.length] as number;
    const w = weights[who] as number[];
    out[who] = (w[left] ?? 0) + (w[right] ?? 0);
  });
  return out;
}

export function table(weights: Weights, margin: number): Table {
  const n = weights.length;
  const seatings = allSeatings(n);
  const points = seatings.map((x) => pointsOf(weights, x));
  const col = (i: number) => points.map((u) => u[i] as number);
  const best = Array.from({ length: n }, (_, i) => Math.max(...col(i)));
  const worst = Array.from({ length: n }, (_, i) => Math.min(...col(i)));
  return {
    n,
    seatings,
    points,
    best,
    worst,
    noDeal: worst.map((v) => v - margin),
  };
}

export function indexOfSeating(t: Table, order: readonly number[]): number {
  const c = canonicalOrder(order).join(",");
  return t.seatings.findIndex((x) => x.join(",") === c);
}

const total = (u: number[]) => u.reduce((a, b) => a + b, 0);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);

// How many seatings are at least as good as x for all and better for one.
export function paretoImprovements(t: Table, x: number): number {
  const ux = t.points[x] as number[];
  return t.points.filter(
    (uy) => !same(uy, ux) && uy.every((v, i) => v >= (ux[i] as number)),
  ).length;
}

export function paretoFrontier(t: Table): number[] {
  return range(t.seatings.length).filter((x) => paretoImprovements(t, x) === 0);
}

export function utilitarian(t: Table): { total: number; seatings: number[] } {
  const top = Math.max(...t.points.map(total));
  return {
    total: top,
    seatings: range(t.seatings.length).filter(
      (x) => total(t.points[x] as number[]) === top,
    ),
  };
}

// Points as a share of each executive's own best, lowest first.
function shares(t: Table, x: number): Q[] {
  return (t.points[x] as number[])
    .map((v, i) =>
      (t.best[i] as number) === 0 ? q(1) : q(v, t.best[i] as number),
    )
    .sort(cmp);
}

function lexi(a: Q[], b: Q[]): number {
  for (let k = 0; k < a.length; k++) {
    const c = cmp(a[k] as Q, b[k] as Q);
    if (c !== 0) return c;
  }
  return 0;
}

// Max-min with ties broken by the next lowest and so on (leximin), on
// points as a share of each executive's own best. Tied seatings share their
// sorted shares but, when bests differ, not always their lowest points, so
// `lowest` and `lowest_max` bound the lowest points over all of them.
export function maxmin(t: Table): {
  lowest: number;
  lowest_max: number;
  seatings: number[];
} {
  const keys = range(t.seatings.length).map((x) => shares(t, x));
  const top = keys.reduce((a, b) => (lexi(b, a) > 0 ? b : a));
  const seatings = range(t.seatings.length).filter(
    (x) => lexi(keys[x] as Q[], top) === 0,
  );
  const lows = seatings.map((x) => Math.min(...(t.points[x] as number[])));
  return {
    lowest: Math.min(...lows),
    lowest_max: Math.max(...lows),
    seatings,
  };
}

// The fair gap: 1 minus the best achievable lowest share of own best.
export function fairGap(t: Table): Q {
  const lows = range(t.seatings.length).map((x) => shares(t, x)[0] as Q);
  return sub(
    q(1),
    lows.reduce((a, b) => (cmp(b, a) > 0 ? b : a)),
  );
}

export function totalGap(t: Table): Q {
  const most = total(t.best);
  return most === 0 ? ZERO : sub(q(1), q(utilitarian(t).total, most));
}

export function nashProduct(t: Table, x: number): bigint {
  return (t.points[x] as number[]).reduce(
    (p, v, i) => p * BigInt(v - (t.noDeal[i] as number)),
    1n,
  );
}

// The seating(s) with the largest product of gains over no deal.
export function nash(t: Table): { product: bigint; seatings: number[] } {
  const all = range(t.seatings.length).map((x) => nashProduct(t, x));
  const top = all.reduce((a, b) => (b > a ? b : a));
  return {
    product: top,
    seatings: range(t.seatings.length).filter((x) => all[x] === top),
  };
}

// Is the even lottery over `support` the Nash solution once lotteries are
// allowed? The exact first-order test: with g_i the lottery's expected gain
// over no deal, every seating x must have sum_i gain_i(x) / g_i <= n.
// Returns the lottery's expected points, or null.
export function lotteryNash(t: Table, support: number[]): Q[] | null {
  const g = range(t.n).map((i) =>
    q(
      support.reduce(
        (s, x) =>
          s +
          ((t.points[x] as number[])[i] as number) -
          (t.noDeal[i] as number),
        0,
      ),
      support.length,
    ),
  );
  if (g.some((gi) => gi.n === 0n)) return null;
  for (const u of t.points) {
    const s = sum(
      range(t.n).map((i) =>
        div(q((u[i] as number) - (t.noDeal[i] as number)), g[i] as Q),
      ),
    );
    if (cmp(s, q(t.n)) > 0) return null;
  }
  return g.map((gi, i) => add(gi, q(t.noDeal[i] as number)));
}

// At least k executives get strictly more from y than from x.
export function beats(t: Table, y: number, x: number, k: number): boolean {
  const ux = t.points[x] as number[];
  return (
    (t.points[y] as number[]).filter((v, i) => v > (ux[i] as number)).length >=
    k
  );
}

// For each seating, how many seatings some k executives would all rather have.
export function dominators(t: Table, k: number): number[] {
  return range(t.seatings.length).map(
    (x) => range(t.seatings.length).filter((y) => beats(t, y, x, k)).length,
  );
}

export function core(t: Table, k: number): number[] {
  const d = dominators(t, k);
  return range(t.seatings.length).filter((x) => d[x] === 0);
}

// ------------------------------------------------ Baron-Ferejohn, finite

export type Cell = {
  passes: boolean;
  own: number | null;
  offers: number[]; // seating indexes, each equally likely
  yes: number[][]; // for each offer, who says yes (the proposer included)
  firm: boolean; // passes without leaning on anyone indifferent
  expect: Q[];
};
export type RoundPlan = {
  round: number;
  goOn: Q[]; // the value of this round failing
  by: Cell[]; // by proposer
  value: Q[]; // the value of reaching this round, before the draw
};

// The no-talk prediction: subgame-perfect play by backward induction, with
// voters who vote as if their vote decided the round. A seating passes with
// `need` yes votes, the proposer's included. After the last round fails
// everyone gets no deal. No discounting.
//
// lean: what an indifferent player does. "yes" (the baseline): an
//   indifferent voter says yes and an indifferent proposer settles. "no":
//   both hold out.
// tie: which of several seatings equally good for the proposer it offers.
//   "generous" (the baseline): the largest total for the other four, then
//   evenly. "even": evenly over all. "harsh": the smallest total for the
//   others, then evenly.
export function bargain(
  t: Table,
  need: number,
  rounds: number,
  tie: Tie = "generous",
  lean: Lean = "yes",
): RoundPlan[] {
  const likes = (u: number, v: Q) =>
    lean === "yes" ? cmp(q(u), v) >= 0 : cmp(q(u), v) > 0;
  let goOn = t.noDeal.map((v) => q(v));
  const out: RoundPlan[] = [];
  for (let round = rounds; round >= 1; round--) {
    const by: Cell[] = [];
    let value = range(t.n).map(() => ZERO);
    for (let p = 0; p < t.n; p++) {
      const passable = range(t.seatings.length).filter(
        (x) =>
          range(t.n).filter(
            (i) =>
              i !== p &&
              likes((t.points[x] as number[])[i] as number, goOn[i] as Q),
          ).length >=
          need - 1,
      );
      const own = passable.length
        ? Math.max(
            ...passable.map((x) => (t.points[x] as number[])[p] as number),
          )
        : null;
      if (own === null || !likes(own, goOn[p] as Q)) {
        by.push({
          passes: false,
          own: null,
          offers: [],
          yes: [],
          firm: true,
          expect: [...goOn],
        });
        value = value.map((v, i) => add(v, div(goOn[i] as Q, q(t.n))));
        continue;
      }
      let offers = passable.filter((x) => (t.points[x] as number[])[p] === own);
      if (tie !== "even") {
        const rest = (x: number) =>
          total(t.points[x] as number[]) -
          ((t.points[x] as number[])[p] as number);
        const rests = offers.map(rest);
        const pick =
          tie === "generous" ? Math.max(...rests) : Math.min(...rests);
        offers = offers.filter((x) => rest(x) === pick);
      }
      const expect = range(t.n).map((i) =>
        q(
          offers.reduce(
            (s, x) => s + ((t.points[x] as number[])[i] as number),
            0,
          ),
          offers.length,
        ),
      );
      const yes = offers.map((x) =>
        range(t.n).filter(
          (i) =>
            i === p ||
            likes((t.points[x] as number[])[i] as number, goOn[i] as Q),
        ),
      );
      const firm =
        cmp(q(own), goOn[p] as Q) > 0 &&
        offers.every(
          (x) =>
            range(t.n).filter(
              (i) =>
                i !== p &&
                cmp(q((t.points[x] as number[])[i] as number), goOn[i] as Q) >
                  0,
            ).length >=
            need - 1,
        );
      by.push({ passes: true, own, offers, yes, firm, expect });
      value = value.map((v, i) => add(v, div(expect[i] as Q, q(t.n))));
    }
    out.push({ round, goOn, by, value });
    goOn = value;
  }
  return out.reverse();
}

// The chance that the first agreement comes in each round, and of none.
export function agreementRounds(plan: RoundPlan[]): {
  rounds: Q[];
  never: Q;
} {
  let left = q(1);
  const rounds: Q[] = [];
  for (const rec of plan) {
    const n = rec.by.length;
    const hit = q(rec.by.filter((c) => c.passes).length, n);
    rounds.push(q(left.n * hit.n, left.d * hit.d));
    left = q(left.n * (hit.d - hit.n), left.d * hit.d);
  }
  return { rounds, never: left };
}

// The prediction for one sequence of proposer draws: the first round whose
// drawn proposer has an offer that passes.
export function predicted(
  plan: RoundPlan[],
  draws: number[],
): { round: number; proposer: number; cell: Cell } | null {
  for (const [k, rec] of plan.entries()) {
    const who = draws[k];
    if (who === undefined) break;
    const cell = rec.by[who] as Cell;
    if (cell.passes) return { round: rec.round, proposer: who, cell };
  }
  return null;
}
