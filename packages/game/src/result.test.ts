import { describe, expect, it } from "vitest";
import { isCompetitionRanking, placesFromScores, resultSchema } from "./result";

const ok = {
  game: "rps",
  match: "m-1",
  at: "2026-10-29T08:00:00Z",
  players: [
    { player: "ruby", place: 1 },
    { player: "jade", place: 2 },
  ],
};

describe("result", () => {
  it("accepts a plain two-player result", () => {
    expect(resultSchema.parse(ok)).toEqual(ok);
  });

  it("accepts ties in competition ranking", () => {
    for (const places of [
      [1, 1],
      [1, 1, 3],
      [1, 2, 2, 4],
      [1, 1, 1, 1],
      [2, 1, 3],
    ])
      expect(isCompetitionRanking(places), String(places)).toBe(true);
  });

  it("refuses places that aren't a competition ranking", () => {
    for (const places of [
      [2, 3],
      [1, 3],
      [1, 1, 2],
      [1, 2, 2, 3],
      [0, 1],
    ])
      expect(isCompetitionRanking(places), String(places)).toBe(false);
  });

  it("refuses a result a Table shouldn't be able to report", () => {
    const bad: unknown[] = [
      { ...ok, players: [{ player: "ruby", place: 1 }] },
      {
        ...ok,
        players: [
          { player: "ruby", place: 1 },
          { player: "ruby", place: 2 },
        ],
      },
      {
        ...ok,
        players: [
          { player: "ruby", place: 1 },
          { player: "jade", place: 3 },
        ],
      },
      { ...ok, players: [{ player: "Ruby!", place: 1 }, ok.players[1]] },
      { ...ok, game: "Rock Paper" },
      { ...ok, match: "-m" },
      { ...ok, match: "m".repeat(65) },
      { ...ok, at: "yesterday" },
      { ...ok, at: "2026-10-29T08:00:00+02:00" },
      { ...ok, winner: "ruby" },
      {
        ...ok,
        players: [{ ...ok.players[0], rating: 9000 }, ok.players[1]],
      },
      {
        ...ok,
        players: Array.from({ length: 65 }, (_, i) => ({
          player: `bot${i}`,
          place: 1,
        })),
      },
    ];
    for (const r of bad)
      expect(resultSchema.safeParse(r).success, JSON.stringify(r)).toBe(false);
  });

  it("works out places from scores", () => {
    expect(
      placesFromScores([
        { player: "ruby", score: 2 },
        { player: "jade", score: 5 },
        { player: "onyx", score: 2 },
        { player: "opal", score: 0 },
      ]),
    ).toEqual([
      { player: "ruby", place: 2 },
      { player: "jade", place: 1 },
      { player: "onyx", place: 2 },
      { player: "opal", place: 4 },
    ]);
    const places = placesFromScores([
      { player: "a1x", score: 1 },
      { player: "b1x", score: 1 },
    ]).map((p) => p.place);
    expect(isCompetitionRanking(places)).toBe(true);
  });
});
