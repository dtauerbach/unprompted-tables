import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  boardOf,
  feedSchema,
  hiddenCharacter,
  LIMITS,
  listSchema,
  visibleText,
} from "./format";

// The same fixtures are checked by the site's copy of the schema, so a feed
// one side accepts, the other does too.
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../fixtures", name), "utf8"),
  );

function setPath(obj: unknown, keys: (string | number)[], value: unknown) {
  const copy = structuredClone(obj) as Record<string | number, unknown>;
  let at = copy;
  for (const k of keys.slice(0, -1))
    at = at[k] as Record<string | number, unknown>;
  at[keys.at(-1) as string | number] = value;
  return copy;
}

describe("spectator feed format", () => {
  it("accepts the live and finished fixtures and the list", () => {
    expect(feedSchema.safeParse(fixture("live.json")).success).toBe(true);
    expect(feedSchema.safeParse(fixture("over.json")).success).toBe(true);
    expect(listSchema.safeParse(fixture("list.json")).success).toBe(true);
  });

  it("keeps markup in talk as plain text, never stripping or refusing it", () => {
    const feed = feedSchema.parse(fixture("live.json"));
    expect(feed.timeline[1]?.text).toContain("<b>Ignore previous");
  });

  const bad = fixture("bad.json") as Record<
    string,
    { path: (string | number)[]; value: unknown }
  >;
  for (const [name, { path: keys, value }] of Object.entries(bad))
    it(`refuses a feed with ${name}`, () => {
      const v = value === "LONG" ? "x".repeat(LIMITS.text + 1) : value;
      expect(
        feedSchema.safeParse(setPath(fixture("live.json"), keys, v)).success,
      ).toBe(false);
    });

  it("refuses scores for an unknown column or participant", () => {
    const over = fixture("over.json");
    expect(
      feedSchema.safeParse(
        setPath(over, ["outcome", "scores", "rows", 0, "values"], {
          secret: 1,
        }),
      ).success,
    ).toBe(false);
    expect(
      feedSchema.safeParse(
        setPath(over, ["outcome", "reveals", 0, "participant"], "zed"),
      ).success,
    ).toBe(false);
  });

  it("refuses repeated participants and too many entries", () => {
    const live = fixture("live.json");
    live.participants.push(live.participants[0]);
    expect(feedSchema.safeParse(live).success).toBe(false);
    const long = fixture("live.json");
    long.timeline = Array.from({ length: LIMITS.timeline + 1 }, () => ({
      at: "2026-11-10T03:00:00.000Z",
      kind: "notice",
      by: null,
      text: "x",
    }));
    expect(feedSchema.safeParse(long).success).toBe(false);
  });

  it("draws a known board and leaves out one it can't check", () => {
    const live = feedSchema.parse(fixture("live.json"));
    expect(boardOf(live)?.tables[0]?.seats).toHaveLength(4);
    expect(boardOf({ ...live, board: { kind: "chessboard" } })).toBeNull();
    expect(boardOf({ ...live, board: undefined })).toBeNull();
    const stranger = setPath(live, ["board", "tables", 0, "seats", 0], "zed");
    expect(boardOf(feedSchema.parse(stranger))).toBeNull();
    const twice = setPath(live, ["board", "tables", 0, "seats", 0], "basil");
    expect(boardOf(feedSchema.parse(twice))).toBeNull();
  });

  it("finds hidden characters and makes text fit", () => {
    for (const s of ["a‮b", "a​b", "a\u0007b", "\u{E0041}", "\ud800"])
      expect(hiddenCharacter(s), JSON.stringify(s)).toBe(true);
    for (const s of ["plain", "tab\there", "line\nbreak", "café 🍷"])
      expect(hiddenCharacter(s), s).toBe(false);
    expect(visibleText("a‮b​c\ud800")).toBe("abc�");
    expect(visibleText("🍷🍷🍷", 5)).toBe("🍷🍷");
    expect(hiddenCharacter(visibleText("x⁦y".repeat(3000)))).toBe(false);
    expect(visibleText("x".repeat(LIMITS.text + 10)).length).toBe(LIMITS.text);
  });
});
