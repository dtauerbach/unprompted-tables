import { describe, expect, it } from "vitest";
import { ELO_START } from "./elo";
import type { Result } from "./result";
import { computeStandings, ELO_METHOD } from "./standings";

let clock = 0;
function result(match: string, ...places: [string, number][]): Result {
  clock += 1;
  return {
    game: "rps",
    match,
    at: new Date(Date.UTC(2026, 9, 29, 0, 0, clock)).toISOString(),
    players: places.map(([player, place]) => ({ player, place })),
  };
}

// Mulberry32, so shuffles are the same on every run.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const next = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe("standings", () => {
  it("is empty before any match", () => {
    expect(computeStandings("rps", [])).toEqual({
      method: ELO_METHOD,
      rows: [],
    });
  });

  it("counts wins, losses and draws and ranks by rating", () => {
    const s = computeStandings("rps", [
      result("m-1", ["ruby", 1], ["jade", 2]),
      result("m-2", ["ruby", 1], ["jade", 1]),
      result("m-3", ["onyx", 1], ["jade", 2]),
    ]);
    // Ruby's draw with a lower-rated jade cost it, so onyx's one clean win
    // ranks higher.
    expect(s.rows.map((r) => r.player)).toEqual(["onyx", "ruby", "jade"]);
    expect(s.rows[1]).toMatchObject({
      player: "ruby",
      played: 2,
      won: 1,
      lost: 0,
      drawn: 1,
    });
    expect(s.rows[2]).toMatchObject({
      player: "jade",
      played: 3,
      won: 0,
      lost: 2,
      drawn: 1,
    });
  });

  it("calls a shared first place a draw and anything below it a loss", () => {
    const s = computeStandings("rps", [
      result("m-1", ["ruby", 1], ["jade", 1], ["onyx", 3]),
    ]);
    const by = new Map(s.rows.map((r) => [r.player, r]));
    expect(by.get("ruby")).toMatchObject({ won: 0, drawn: 1, lost: 0 });
    expect(by.get("onyx")).toMatchObject({ won: 0, drawn: 0, lost: 1 });
  });

  it("gives the same standings whatever order results arrive in", () => {
    const handles = ["ruby", "jade", "onyx", "opal", "amber"];
    const next = rng(7);
    const results: Result[] = [];
    for (let i = 0; i < 200; i++) {
      const a = handles[Math.floor(next() * 5)] as string;
      let b = a;
      while (b === a) b = handles[Math.floor(next() * 5)] as string;
      const roll = next();
      results.push(
        result(
          `m-${i}`,
          [a, roll < 0.45 ? 1 : roll < 0.55 ? 1 : 2],
          [b, roll < 0.45 ? 2 : 1],
        ),
      );
    }
    const first = computeStandings("rps", results);
    for (const seed of [1, 2, 3])
      expect(computeStandings("rps", shuffle(results, seed))).toEqual(first);
    // Ratings are zero-sum, so they average to the start rating.
    const mean =
      first.rows.reduce((t, r) => t + r.rating, 0) / first.rows.length;
    expect(Math.abs(mean - ELO_START)).toBeLessThan(1);
  });

  it("breaks rating ties by wins and then by handle", () => {
    const s = computeStandings("rps", [
      result("m-1", ["zed1", 1], ["amy1", 1]),
    ]);
    expect(s.rows.map((r) => r.player)).toEqual(["amy1", "zed1"]);
  });

  it("orders results recorded at the same moment by match", () => {
    const at = "2026-10-29T08:00:00Z";
    const a = { ...result("m-a", ["ruby", 1], ["jade", 2]), at };
    const b = { ...result("m-b", ["jade", 1], ["ruby", 2]), at };
    expect(computeStandings("rps", [b, a])).toEqual(
      computeStandings("rps", [a, b]),
    );
  });

  it("lists everyone unless the Table asks for only the top rows", () => {
    const results = Array.from({ length: 150 }, (_, i) =>
      result(`m-${i}`, [`bot${i}`, 1], [`low${i}`, 2]),
    );
    expect(computeStandings("rps", results).rows).toHaveLength(300);
    const top = computeStandings("rps", results, { top: 100 });
    expect(top.rows).toHaveLength(100);
    expect(top.rows.every((r) => r.player.startsWith("bot"))).toBe(true);
    expect(computeStandings("rps", results, { top: 0 }).rows).toEqual([]);
    for (const top of [-1, 1.5, Number.NaN])
      expect(() => computeStandings("rps", results, { top })).toThrow(/top/);
  });

  it("refuses results it can't trust", () => {
    const one = result("m-1", ["ruby", 1], ["jade", 2]);
    expect(() => computeStandings("rps", [one, one])).toThrow(/twice/);
    expect(() => computeStandings("rps", [{ ...one, game: "chess" }])).toThrow(
      /not rps/,
    );
    expect(() =>
      computeStandings("rps", [{ ...one, players: [one.players[0]] }]),
    ).toThrow();
    expect(() => computeStandings("rps", [{ nonsense: true }])).toThrow();
  });
});
