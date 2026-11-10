import { describe, expect, it } from "vitest";
import type { Deal } from "./deal";
import { start } from "./match";
import { bounds, scores } from "./score";
import { boundsOf } from "./spectate";
import { VARIANTS } from "./variants";

// The old party's feed reads its bounds from a memo kept per deal, so a
// public feed read doesn't search every seating each time.

const dealOf = (seed: string): Deal => {
  const events = start(
    ["alice", "bobby", "carol", "david", "ellen", "frank"],
    VARIANTS.classic as NonNullable<typeof VARIANTS.classic>,
    new Date("2026-11-10T03:00:00.000Z"),
    seed,
  );
  const e = events.find((x) => x.body.kind === "deal");
  return (e?.body as { deal: Deal }).deal;
};

describe("the old party's bounds memo", () => {
  it("gives the right bounds, and the same ones again without a search", () => {
    const d = dealOf("memo-1");
    const first = boundsOf(d);
    const b = bounds(d.feel);
    expect(first.b).toEqual(b);
    expect(first.fair).toEqual(scores(d.feel, b.fairest));
    // The same feelings, read again or from a copy of the deal: kept.
    expect(boundsOf(d)).toBe(first);
    expect(boundsOf(structuredClone(d))).toBe(first);
    // Another deal gets its own.
    const other = dealOf("memo-2");
    expect(boundsOf(other)).not.toBe(first);
    expect(boundsOf(other).b).toEqual(bounds(other.feel));
  });

  it("keeps a bounded number of deals, forgetting the oldest", () => {
    const d = dealOf("memo-old");
    const kept = boundsOf(d);
    for (let i = 0; i < 260; i++) {
      const feel = d.feel.map((row) => row.map((v) => v));
      (feel[0] as number[])[1] = 1000 + i;
      boundsOf({ ...d, feel });
    }
    const again = boundsOf(d);
    expect(again).not.toBe(kept);
    expect(again).toEqual(kept);
  });
});
