import { describe, expect, it } from "vitest";
import { report } from "./score";
import { scoreTable } from "./spectate";

// The party of Nov 10 (m_tSOmhrbit2di): P2 won, and was also the fairest
// seating. Its table showed Otto's 2 of 6 as 60% and a column of 0%s.
const guests = ["Cora", "Hugo", "Otto", "Dev", "Basil"];
const feel = [
  [0, 0, 3, 3, -3],
  [0, 0, -3, 3, 3],
  [-1, -3, 0, 3, 3],
  [1, 3, -3, 0, 3],
  [0, 3, -3, 3, 0],
];
const at = (names: string[]) => names.map((n) => guests.indexOf(n));
const row = (t: ReturnType<typeof scoreTable>, who: string) =>
  t.rows.find((r) => r.participant === who)?.values;

describe("the score table", () => {
  it("shows each guest's worst beside their best, so satisfaction reads", () => {
    const r = report(feel, at(["Otto", "Cora", "Dev", "Hugo", "Basil"]));
    const t = scoreTable(guests, { feel }, r);
    expect(t.columns.map((c) => c.key)).toEqual([
      "score",
      "worst",
      "best",
      "satisfaction",
    ]);
    // Otto: 2 between -4 (Cora and Hugo) and 6 (Dev and Basil) is 60%.
    expect(row(t, "otto")).toEqual({
      score: 2,
      worst: -4,
      best: 6,
      satisfaction: 0.6,
    });
    for (const v of t.rows.map((x) => x.values)) {
      const { score, worst, best, satisfaction } = v as {
        score: number;
        worst: number;
        best: number;
        satisfaction: number;
      };
      expect(worst).toBeLessThanOrEqual(score);
      expect(score).toBeLessThanOrEqual(best);
      expect(satisfaction).toBeCloseTo(
        best === worst ? 1 : (score - worst) / (best - worst),
      );
    }
  });

  it("drops the fairest column when the seating is the fairest one", () => {
    const r = report(feel, at(["Otto", "Cora", "Dev", "Hugo", "Basil"]));
    expect(r.short_of_fairest.every((x) => x === 0)).toBe(true);
    const t = scoreTable(guests, { feel }, r);
    expect(t.columns.some((c) => c.key === "vs_fairest")).toBe(false);
    expect(t.rows.every((x) => !("vs_fairest" in x.values))).toBe(true);
  });

  it("keeps it, signed, when the seating isn't the fairest", () => {
    // Otto between Hugo and Cora: his worst seat.
    const r = report(feel, at(["Hugo", "Otto", "Cora", "Dev", "Basil"]));
    const t = scoreTable(guests, { feel }, r);
    expect(t.columns.at(-1)?.key).toBe("vs_fairest");
    expect(row(t, "otto")?.score).toBe(-4);
    expect(row(t, "otto")?.satisfaction).toBe(0);
    // Positive means better off than the fairest seating; Otto is worse off.
    expect(row(t, "otto")?.vs_fairest).toBeLessThan(0);
    for (const [i, g] of guests.entries())
      expect(row(t, g.toLowerCase())?.vs_fairest).toBeCloseTo(
        -(r.short_of_fairest[i] as number),
      );
  });
});
