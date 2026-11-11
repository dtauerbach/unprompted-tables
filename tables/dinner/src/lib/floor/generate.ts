import { allSeatings, pointsOf } from "../exec/solver";
import { pick, rng, shuffle } from "../rng";
import type { Level } from "./variants";

// The open floor's deals: a payoff table that can't settle. Five
// executives (0 to 4) and the keynote speaker (5) at one round table; an
// executive's points are their entries for their two neighbours, added up.
// Likes are public; each secret dislike only its holder's assistant sees.
//
// A draw follows the design's generator:
// 1. The five in a shuffled ring, each with a big like for the next one
//    round, so nobody's big wish is returned.
// 2. Each a small like for one other executive, and a value for the speaker
//    from the level's list, shuffled.
// 3. Each secret holder a secret dislike (two in knives) of someone they
//    don't like, 70 percent of the time someone who likes them.
// A draw is kept only if, by brute force over the 60 seatings, the table
// can't settle but looks as if it could to anyone who knows only the likes
// (checkDeal). Draws come from the seed's "deal" stream, one after another,
// so a seed always gives the same deal.

export const N = 5;
export const SPEAKER_INDEX = 5;
export const MAX_TRIES = 500;

export type LevelDeal = {
  // Big like, small like.
  likes: [number, number];
  // One value for the speaker per executive, shuffled.
  speaker: number[];
  // A holder's secret dislikes, in order of how hard.
  dislikes: number[];
  // How many executives hold a secret.
  holders: number;
  // At least this many first secrets are of someone who likes the holder.
  unrequited: number;
  // The seating with the most public likes seats at least this many
  // executives beside a secret dislike.
  poisoned: number;
};

export const LEVEL_DEALS: Record<Level, LevelDeal> = {
  simmer: {
    likes: [4, 2],
    speaker: [3, 3, 2, 0, 0],
    dislikes: [-3],
    holders: 3,
    unrequited: 0,
    poisoned: 1,
  },
  feud: {
    likes: [4, 2],
    speaker: [3, 3, 2, 0, 0],
    dislikes: [-5],
    holders: 5,
    unrequited: 2,
    poisoned: 2,
  },
  knives: {
    likes: [5, 2],
    speaker: [4, 3, 0, 0, 0],
    dislikes: [-6, -3],
    holders: 5,
    unrequited: 3,
    poisoned: 2,
  },
};

// Each secret, hidden on its own holder's row, must change at least this
// share of the "x beats y" majority comparisons.
export const MIN_FLIP = 0.02;
// In every seating someone is at or below this share of their own range.
export const LOSER_SHARE = 0.5;
export const MAJORITY = 3;

export type Draw = {
  // weights[i][j]: i's points for j beside them, secrets included; j = 5
  // is the speaker.
  weights: number[][];
  // secrets[i]: whom i secretly dislikes, hardest first; [] for none.
  secrets: number[][];
  // How many first secrets are of someone who likes the holder.
  unrequited: number;
};

export const SEATINGS: number[][] = allSeatings(N);
export const COMPARISONS = SEATINGS.length * (SEATINGS.length - 1);

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function draw(r: () => number, L: LevelDeal): Draw {
  const weights = range(N).map(() => new Array<number>(N + 1).fill(0));
  const secrets: number[][] = range(N).map(() => []);
  const speaker = shuffle(r, L.speaker);
  const ring = shuffle(r, range(N));
  for (let k = 0; k < N; k++) {
    const i = ring[k] as number;
    const j = ring[(k + 1) % N] as number;
    const row = weights[i] as number[];
    row[j] = L.likes[0];
    row[SPEAKER_INDEX] = speaker[i] as number;
    const others = shuffle(
      r,
      range(N).filter((x) => x !== i && x !== j),
    );
    row[others[0] as number] = L.likes[1];
  }
  let unrequited = 0;
  for (const i of shuffle(r, range(N)).slice(0, L.holders)) {
    const row = weights[i] as number[];
    const candidates = shuffle(
      r,
      range(N).filter((x) => x !== i && row[x] === 0),
    );
    // Those who like i first (a stable sort keeps the shuffle among equals).
    candidates.sort(
      (a, b) =>
        ((weights[b] as number[])[i] as number) -
        ((weights[a] as number[])[i] as number),
    );
    const chosen = r() < 0.7 ? candidates : shuffle(r, candidates);
    L.dislikes.forEach((d, n) => {
      const who = chosen[n];
      if (who === undefined) return;
      row[who] = d;
      (secrets[i] as number[]).push(who);
      if (n === 0 && ((weights[who] as number[])[i] as number) > 0)
        unrequited++;
    });
  }
  return { weights, secrets, unrequited };
}

// The table with every secret zeroed: what anyone who knows only the likes
// sees.
export function publicWeights(d: {
  weights: number[][];
  secrets: number[][];
}): number[][] {
  return d.weights.map((row, i) =>
    row.map((v, j) => ((d.secrets[i] as number[]).includes(j) ? 0 : v)),
  );
}

export const pointsTable = (weights: number[][]): number[][] =>
  SEATINGS.map((s) => pointsOf(weights, s));

// y beats x: at least three executives strictly prefer y.
export function beats(P: number[][], y: number, x: number): boolean {
  const py = P[y] as number[];
  const px = P[x] as number[];
  let n = 0;
  for (let i = 0; i < N; i++) if ((py[i] as number) > (px[i] as number)) n++;
  return n >= MAJORITY;
}

// How many seatings beat each seating.
export function challengers(P: number[][]): number[] {
  return SEATINGS.map((_, x) =>
    SEATINGS.reduce((n, _s, y) => n + (y !== x && beats(P, y, x) ? 1 : 0), 0),
  );
}

// Seatings no three executives would all rather replace: the core under 3
// of 5. Counted without listing, stopping at `stop`.
export function coreSize(P: number[][], stop = Infinity): number {
  let n = 0;
  for (let x = 0; x < SEATINGS.length && n < stop; x++) {
    let beaten = false;
    for (let y = 0; y < SEATINGS.length && !beaten; y++)
      beaten = y !== x && beats(P, y, x);
    if (!beaten) n++;
  }
  return n;
}

// The share of the ordered "y beats x" comparisons that differ.
export function flipShare(A: number[][], B: number[][]): number {
  let f = 0;
  for (let x = 0; x < SEATINGS.length; x++)
    for (let y = 0; y < SEATINGS.length; y++)
      if (x !== y && beats(A, y, x) !== beats(B, y, x)) f++;
  return f / COMPARISONS;
}

export function bounds(P: number[][]): { best: number[]; worst: number[] } {
  const col = (i: number) => P.map((u) => u[i] as number);
  return {
    best: range(N).map((i) => Math.max(...col(i))),
    worst: range(N).map((i) => Math.min(...col(i))),
  };
}

// How many executives a seating puts beside one of their secret dislikes.
export function poisonedSeats(order: readonly number[], secrets: number[][]) {
  const ring = [SPEAKER_INDEX, ...order];
  let n = 0;
  for (let k = 1; k < ring.length; k++) {
    const who = ring[k] as number;
    const left = ring[k - 1] as number;
    const right = ring[(k + 1) % ring.length] as number;
    const mine = secrets[who] as number[];
    if (mine.includes(left) || mine.includes(right)) n++;
  }
  return n;
}

export type Check = {
  ok: boolean;
  // Which check failed first, for tests and the loud failure.
  failed: string | null;
};

// Whether a draw makes a table that can't settle. Cheap checks first, so a
// draw that fails is dropped quickly.
export function checkDeal(d: Draw, L: LevelDeal, margin = 3): Check {
  const no = (failed: string): Check => ({ ok: false, failed });
  if (d.unrequited < L.unrequited) return no("unrequited");
  const P = pointsTable(d.weights);
  // Empty core: every seating is beaten by one that three strictly prefer.
  if (coreSize(P, 1) > 0) return no("empty_core");
  // Someone always loses: in every seating, someone is at or below half
  // of their own range, worst to best.
  const { best, worst } = bounds(P);
  for (const u of P) {
    const low = Math.min(
      ...u.map((v, i) => {
        const span = (best[i] as number) - (worst[i] as number);
        return span === 0 ? 1 : (v - (worst[i] as number)) / span;
      }),
    );
    if (low > LOSER_SHARE) return no("someone_loses");
  }
  // No deal is below every executive's worst seating.
  if (margin <= 0) return no("no_deal");
  // Public calm: with the secrets zeroed, some seating is unbeaten.
  const pub = publicWeights(d);
  const Pp = pointsTable(pub);
  if (coreSize(Pp, 1) === 0) return no("public_core");
  // The obvious seating is poisoned: every seating with the most public
  // likes seats enough executives beside a secret dislike.
  const totals = Pp.map((u) => u.reduce((a, b) => a + b, 0));
  const top = Math.max(...totals);
  const obvious = SEATINGS.filter((_, x) => totals[x] === top);
  if (Math.min(...obvious.map((s) => poisonedSeats(s, d.secrets))) < L.poisoned)
    return no("poisoned");
  // Each secret matters: hiding one holder's secrets changes enough of the
  // majority comparisons that knowing it changes which coalitions exist.
  for (let i = 0; i < N; i++) {
    if ((d.secrets[i] as number[]).length === 0) continue;
    const hidden = d.weights.map((row, a) =>
      a === i
        ? row.map((v, j) => ((d.secrets[i] as number[]).includes(j) ? 0 : v))
        : row,
    );
    if (flipShare(P, pointsTable(hidden)) < MIN_FLIP)
      return no("secret_matters");
  }
  return { ok: true, failed: null };
}

export type Deal = Draw & { tries: number };

// The deal for a seed: the first draw from its "deal" stream that passes
// every check. Gives up loudly after `tries` draws, so a broken level
// fails the start instead of dealing a table that settles.
export function dealFor(
  seed: string,
  level: Level,
  opts: { tries?: number; margin?: number } = {},
): Deal {
  const L = LEVEL_DEALS[level];
  const r = rng(seed, "deal");
  const tries = opts.tries ?? MAX_TRIES;
  for (let t = 1; t <= tries; t++) {
    const d = draw(r, L);
    if (checkDeal(d, L, opts.margin ?? 3).ok) return { ...d, tries: t };
  }
  throw new Error(
    `no ${level} deal passed the checks in ${tries} draws; the level needs looking at`,
  );
}

// When dinner is served, in seconds after the start: uniform over the
// window in its steps, from a stream of its own.
export function servedAfter(
  seed: string,
  w: { from: number; to: number; step: number },
): number {
  const steps = (w.to - w.from) / w.step + 1;
  return w.from + pick(rng(seed, "served"), steps) * w.step;
}

// Which player plays which executive: cast[k] is players[k]'s executive.
export function castFor(seed: string): number[] {
  return shuffle(rng(seed, "cast"), range(N));
}
