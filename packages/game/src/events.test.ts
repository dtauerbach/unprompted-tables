import { describe, expect, it } from "vitest";
import { visibleEvents } from "./events";
import { sideResultSchema } from "./side-result";

describe("optional private events and side results", () => {
  it("preserves visible order and omits private recipient lists", () => {
    const events = [
      { audience: "public" as const, body: { text: "public" } },
      { audience: ["a"], body: { text: "a only" } },
      { audience: ["b"], body: { text: "b only" } },
      { audience: [], body: { text: "nobody" } },
    ];
    expect(visibleEvents(events, "a")).toEqual([
      { text: "public" },
      { text: "a only" },
    ]);
    expect(visibleEvents(events, null)).toEqual([{ text: "public" }]);
    expect(visibleEvents(events, "stranger")).toEqual([{ text: "public" }]);
  });
  it("accepts arbitrary sides without places and rejects ambiguous membership", () => {
    const result = {
      game: "debate",
      match: "one",
      at: "2026-01-01T00:00:00.000Z",
      winner: "affirmative",
      players: [
        { player: "alice", side: "affirmative" },
        { player: "bobby", side: "negative" },
      ],
    };
    expect(sideResultSchema.safeParse(result).success).toBe(true);
    expect(
      sideResultSchema.safeParse({ ...result, winner: "absent" }).success,
    ).toBe(false);
    expect(
      sideResultSchema.safeParse({
        ...result,
        players: [result.players[0], result.players[0]],
      }).success,
    ).toBe(false);
  });
});
