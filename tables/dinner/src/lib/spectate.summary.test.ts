import { feedSchema } from "@unprompted-tables/spectator";
import { describe, expect, it } from "vitest";
import { advance, apply, type MatchState, replay, start } from "./match";
import { report } from "./score";
import { feed, scoreTable } from "./spectate";
import { VARIANTS, type Variant } from "./variants";

const T0 = new Date("2026-11-10T03:00:00.000Z");
const SAID = " No seating would have left its worst-off guest better off.";

// Nobody proposes, so the deadline's fallback seats the table.
function ended(variant: Variant, seed: string) {
  const opening = start(
    ["alice", "bobby", "carol", "david", "ellen"],
    variant,
    T0,
    seed,
  );
  const s0 = replay("m_abcdefghijkl", opening);
  const closing = advance(
    s0,
    new Date(T0.getTime() + (variant.talk_seconds + 1) * 1000),
  );
  return feedSchema.parse(
    feed(closing.reduce(apply, s0), [...opening, ...closing]),
  );
}

describe("a finished party's feed", () => {
  it("drops the column and says so in words when the host seats the fairest plan, and neither for a draw", () => {
    const fair = ended(VARIANTS["kind-host"] as Variant, "42");
    expect(fair.outcome?.summary).toContain(SAID);
    expect(fair.outcome?.scores?.columns).toEqual([
      { key: "score", label: "Score", format: "number" },
      { key: "worst", label: "Worst possible", format: "number" },
      { key: "best", label: "Best possible", format: "number" },
      { key: "satisfaction", label: "Satisfaction", format: "percent" },
    ]);
    const drawn = ended(VARIANTS.quick as Variant, "42");
    expect(drawn.outcome?.summary).not.toContain("No seating");
    expect(drawn.outcome?.scores?.columns.at(-1)).toEqual({
      key: "vs_fairest",
      label: "Against fairest seating",
      format: "percent",
    });
    expect(
      drawn.outcome?.scores?.rows.some((r) => r.values.vs_fairest !== 0),
    ).toBe(true);
  });

  // The sentence follows the worst-off guest alone; the column follows
  // every guest, so a seating can earn the sentence and keep the column.
  it("says it beside the column for a seating that only ties the fairest's worst-off guest", () => {
    const guests = ["Cora", "Hugo", "Otto", "Dev", "Basil"];
    const feel = [
      [0, 0, 3, 3, -3],
      [0, 0, -3, 3, 3],
      [-1, -3, 0, 3, 3],
      [1, 3, -3, 0, 3],
      [0, 3, -3, 3, 0],
    ];
    // A party that agreed on a seating, as its feed.
    const agreed = (seating: string[]) => {
      const deal = {
        seed: "0",
        guests,
        personas: guests.map(() => null),
        feel,
        secret: feel.map((row) => row.map(() => false)),
      };
      const s: MatchState = {
        id: "m_abcdefghijkl",
        players: ["alice", "bobby", "carol", "david", "ellen"],
        variant: VARIANTS.quick as Variant,
        guests,
        personas: deal.personas,
        deal,
        phase: "over",
        opened: T0.toISOString(),
        talks: {},
        backs: {},
        proposals: [],
        backing: {},
        end: {
          kind: "end",
          at: T0.toISOString(),
          how: "consensus",
          proposal: "P1",
          seating,
          deal,
          report: report(
            feel,
            seating.map((n) => guests.indexOf(n)),
          ),
        },
      };
      return feedSchema.parse(feed(s, []));
    };
    const tied = agreed(["Cora", "Hugo", "Dev", "Basil", "Otto"]);
    expect(tied.outcome?.summary).toBe(
      `Everyone backed P1, so that's the seating. Basil came off worst, at 33% satisfaction.${SAID}`,
    );
    expect(tied.outcome?.scores?.columns.at(-1)?.key).toBe("vs_fairest");
    // Otto between Hugo and Cora, the worst seat for Otto: the fairest does better.
    expect(
      agreed(["Hugo", "Otto", "Cora", "Dev", "Basil"]).outcome?.summary,
    ).toBe(
      "Everyone backed P1, so that's the seating. Otto came off worst, at 0% satisfaction.",
    );
    const r = report(
      feel,
      ["Cora", "Hugo", "Dev", "Basil", "Otto"].map((n) => guests.indexOf(n)),
    );
    expect(r.worst_off).toBe(r.best_worst_off);
    const t = scoreTable(guests, { feel }, r);
    expect(t.columns.at(-1)?.key).toBe("vs_fairest");
    expect(t.rows.map((x) => x.values.vs_fairest)).toEqual([
      expect.closeTo(-1 / 3),
      expect.closeTo(-1 / 3),
      0,
      0.25,
      0,
    ]);
  });
});
