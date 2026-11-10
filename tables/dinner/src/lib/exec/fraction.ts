// Exact rational numbers, for the benchmarks. Thresholds in the bargaining
// prediction are often exact ties (7 against 7), so nothing is compared in
// floating point: a fraction is a BigInt numerator over a positive BigInt
// denominator, always in lowest terms.

export type Q = { readonly n: bigint; readonly d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function q(n: bigint | number, d: bigint | number = 1n): Q {
  let num = BigInt(n);
  let den = BigInt(d);
  if (den === 0n) throw new RangeError("division by zero");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { n: num / g, d: den / g };
}

export const ZERO = q(0);

export const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
export const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);

// Negative, zero or positive as a is below, equal to or above b.
export function cmp(a: Q, b: Q): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

// The same spelling as Python's str(Fraction): "28/5", "-10", "7".
export function str(a: Q): string {
  return a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`;
}

export function num(a: Q): number {
  return Number(a.n) / Number(a.d);
}

export function sum(xs: Q[]): Q {
  return xs.reduce(add, ZERO);
}
