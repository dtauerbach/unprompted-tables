// Scoring a seating at one round table, exactly. A guest's score is how they
// feel about their two neighbours, added up. Every seating is checked, so
// "the best possible" means the best of all of them, not a guess.
//
// feel[i][j] is how guest i feels about sitting beside guest j. A seating is
// a list of guest indexes around the table; the last sits beside the first.

export type Feelings = number[][];

export function scores(feel: Feelings, seating: readonly number[]): number[] {
  const n = seating.length;
  const out = new Array<number>(n).fill(0);
  seating.forEach((g, k) => {
    const left = seating[(k + n - 1) % n] as number;
    const right = seating[(k + 1) % n] as number;
    out[g] = (feel[g]?.[left] ?? 0) + (feel[g]?.[right] ?? 0);
  });
  return out;
}

// Every distinct seating up to rotation (guest 0 sits first). Mirror images
// are both listed; that changes no best or worst.
export function* seatings(n: number): Generator<number[]> {
  const rest = Array.from({ length: n - 1 }, (_, i) => i + 1);
  const c = new Array<number>(rest.length).fill(0);
  yield [0, ...rest];
  let i = 0;
  while (i < rest.length) {
    if ((c[i] as number) < i) {
      const j = i % 2 === 0 ? 0 : (c[i] as number);
      [rest[j], rest[i]] = [rest[i] as number, rest[j] as number];
      yield [0, ...rest];
      c[i] = (c[i] as number) + 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

export type Bounds = {
  best: number[];
  worst: number[];
  best_total: number;
  worst_total: number;
  // The seating whose worst-off guest does best (ties: the bigger total).
  fairest: number[];
  fairest_floor: number;
  // The seating with the biggest total (ties: the better worst-off guest).
  biggest: number[];
};

const share = (v: number, lo: number, hi: number) =>
  hi === lo ? 1 : (v - lo) / (hi - lo);

export function satisfaction(
  s: readonly number[],
  b: Pick<Bounds, "best" | "worst">,
): number[] {
  return s.map((v, g) => share(v, b.worst[g] as number, b.best[g] as number));
}

export function bounds(feel: Feelings): Bounds {
  const n = feel.length;
  const best = new Array<number>(n).fill(Number.NEGATIVE_INFINITY);
  const worst = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
  let best_total = Number.NEGATIVE_INFINITY;
  let worst_total = Number.POSITIVE_INFINITY;
  const all: { seating: number[]; s: number[]; total: number }[] = [];
  for (const seating of seatings(n)) {
    const s = scores(feel, seating);
    const total = s.reduce((a, b) => a + b, 0);
    s.forEach((v, g) => {
      if (v > (best[g] as number)) best[g] = v;
      if (v < (worst[g] as number)) worst[g] = v;
    });
    best_total = Math.max(best_total, total);
    worst_total = Math.min(worst_total, total);
    all.push({ seating, s, total });
  }
  let fairest = all[0] as (typeof all)[number];
  let fairest_floor = Number.NEGATIVE_INFINITY;
  let biggest = all[0] as (typeof all)[number];
  let biggest_floor = Number.NEGATIVE_INFINITY;
  for (const a of all) {
    const floor = Math.min(...satisfaction(a.s, { best, worst }));
    if (
      floor > fairest_floor ||
      (floor === fairest_floor && a.total > fairest.total)
    ) {
      fairest = a;
      fairest_floor = floor;
    }
    if (
      a.total > biggest.total ||
      (a.total === biggest.total && floor > biggest_floor)
    ) {
      biggest = a;
      biggest_floor = floor;
    }
  }
  return {
    best,
    worst,
    best_total,
    worst_total,
    fairest: fairest.seating,
    fairest_floor,
    biggest: biggest.seating,
  };
}

export type Report = {
  scores: number[];
  satisfaction: number[];
  // How far each guest fell short of what the fairest seating gave them.
  // Negative means they did better than under it.
  short_of_fairest: number[];
  value_captured: number;
  worst_off: number;
  best_worst_off: number;
  // Pairs of guests who would both be happier trading seats.
  swaps: [number, number][];
};

export function report(feel: Feelings, seating: readonly number[]): Report {
  const b = bounds(feel);
  const s = scores(feel, seating);
  const sat = satisfaction(s, b);
  const fair = satisfaction(scores(feel, b.fairest), b);
  const swaps: [number, number][] = [];
  for (let x = 0; x < seating.length; x++)
    for (let y = x + 1; y < seating.length; y++) {
      const traded = [...seating];
      [traded[x], traded[y]] = [traded[y] as number, traded[x] as number];
      const t = scores(feel, traded);
      const i = seating[x] as number;
      const j = seating[y] as number;
      if (
        (t[i] as number) > (s[i] as number) &&
        (t[j] as number) > (s[j] as number)
      )
        swaps.push(i < j ? [i, j] : [j, i]);
    }
  const total = s.reduce((a, v) => a + v, 0);
  return {
    scores: s,
    satisfaction: sat,
    short_of_fairest: fair.map((f, g) => f - (sat[g] as number)),
    value_captured: share(total, b.worst_total, b.best_total),
    worst_off: Math.min(...sat),
    best_worst_off: b.fairest_floor,
    swaps,
  };
}

// The same seating whichever guest you start from or which way you go round.
export function canonical(seating: readonly number[]): string {
  const n = seating.length;
  const at = seating.indexOf(0);
  const cw = Array.from({ length: n }, (_, k) => seating[(at + k) % n]);
  const ccw = Array.from({ length: n }, (_, k) => seating[(at - k + n) % n]);
  const a = cw.join(",");
  const b = ccw.join(",");
  return a < b ? a : b;
}
