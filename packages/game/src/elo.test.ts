import { describe, expect, it } from "vitest";
import { ELO_K, ELO_START, eloChanges, expected } from "./elo";
import type { Result } from "./result";

function match(...places: [string, number][]): Result {
  return {
    game: "rps",
    match: "m",
    at: "2026-10-29T08:00:00Z",
    players: places.map(([player, place]) => ({ player, place })),
  };
}

function sum(m: Map<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

describe("elo", () => {
  it("expects an even game between equals", () => {
    expect(expected(1500, 1500)).toBe(0.5);
    expect(expected(1900, 1500)).toBeCloseTo(10 / 11);
    expect(expected(1500, 1900) + expected(1900, 1500)).toBeCloseTo(1);
  });

  it("moves equals by half of K", () => {
    const c = eloChanges(match(["ruby", 1], ["jade", 2]), new Map());
    expect(c.get("ruby")).toBe(ELO_K / 2);
    expect(c.get("jade")).toBe(-ELO_K / 2);
  });

  it("leaves equals where they were after a draw", () => {
    const c = eloChanges(match(["ruby", 1], ["jade", 1]), new Map());
    expect(c.get("ruby")).toBe(0);
    expect(c.get("jade")).toBe(0);
  });

  it("moves a favourite's rating little for a win and a lot for a loss", () => {
    const ratings = new Map([
      ["ruby", 1900],
      ["jade", 1500],
    ]);
    const win = eloChanges(match(["ruby", 1], ["jade", 2]), ratings);
    const loss = eloChanges(match(["ruby", 2], ["jade", 1]), ratings);
    expect(win.get("ruby")).toBeCloseTo(ELO_K / 11);
    expect(loss.get("ruby")).toBeCloseTo(-ELO_K * (10 / 11));
    // A draw against a weaker player costs the favourite.
    const draw = eloChanges(match(["ruby", 1], ["jade", 1]), ratings);
    expect(draw.get("ruby")).toBeLessThan(0);
  });

  it("is zero-sum and symmetric for any number of players", () => {
    const ratings = new Map([
      ["a1x", 1620],
      ["b1x", 1480],
      ["c1x", 1555],
      ["d1x", 1390],
    ]);
    const c = eloChanges(
      match(["a1x", 3], ["b1x", 1], ["c1x", 1], ["d1x", 4]),
      ratings,
    );
    expect(sum(c)).toBeCloseTo(0, 10);
    // The order players are listed in changes nothing.
    const flipped = eloChanges(
      match(["d1x", 4], ["c1x", 1], ["b1x", 1], ["a1x", 3]),
      ratings,
    );
    for (const p of c.keys()) expect(flipped.get(p)).toBeCloseTo(c.get(p) ?? 0);
  });

  it("caps a multiplayer swing at K", () => {
    const players: [string, number][] = Array.from({ length: 8 }, (_, i) => [
      `bot${i}`,
      i + 1,
    ]);
    const c = eloChanges(match(...players), new Map());
    for (const delta of c.values())
      expect(Math.abs(delta)).toBeLessThanOrEqual(ELO_K / 2 + 1e-9);
    expect(c.get("bot0")).toBeCloseTo(ELO_K / 2);
    expect(c.get("bot7")).toBeCloseTo(-ELO_K / 2);
  });

  it("starts unknown players at the start rating", () => {
    const c = eloChanges(
      match(["ruby", 1], ["jade", 2]),
      new Map([["jade", ELO_START]]),
    );
    expect(c.get("ruby")).toBe(ELO_K / 2);
  });
});
