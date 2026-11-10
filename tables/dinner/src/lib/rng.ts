import { createHmac, randomBytes } from "node:crypto";

// A match's draws come from a 128-bit secret seed, so they replay exactly
// from the seed it recorded and can't be guessed from what the match shows.
// Each stream (the public guest list, the private feelings, the fallback
// seating) is HMAC-SHA256 of the seed over its own name and a counter, so
// seeing the draws of one says nothing about another.
export function newSeed(): string {
  return randomBytes(16).toString("hex");
}

export function rng(seed: string, stream: string): () => number {
  let counter = 0;
  let block = Buffer.alloc(0);
  let at = 0;
  return () => {
    if (at + 4 > block.length) {
      block = createHmac("sha256", seed)
        .update(`${stream}\0${counter++}`)
        .digest();
      at = 0;
    }
    const n = block.readUInt32BE(at);
    at += 4;
    return n / 2 ** 32;
  };
}

export function pick(r: () => number, n: number): number {
  return Math.floor(r() * n);
}

export function shuffle<T>(r: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(r, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
