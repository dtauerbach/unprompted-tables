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

  // Each bad case changes one thing in a good fixture, live.json unless it
  // names another. "LONG" stands for text one over its limit, and "TOO_MANY"
  // for a list one entry over its limit, padded with copies of its first
  // entry under new ids, which must pass at exactly the limit.
  const MANY: Record<string, number> = {
    participants: LIMITS.participants,
    timeline: LIMITS.timeline,
    matches: LIMITS.listed,
  };
  const bad = fixture("bad.json") as Record<
    string,
    { base?: string; path: (string | number)[]; value: unknown }
  >;
  for (const [name, c] of Object.entries(bad))
    it(`refuses a feed with ${name}`, () => {
      const good = fixture(c.base ?? "live.json");
      const schema = c.base === "list.json" ? listSchema : feedSchema;
      expect(schema.safeParse(good).success).toBe(true);
      let value = c.value;
      if (value === "LONG") value = "x".repeat(LIMITS.text + 1);
      // One over the limit, each distinct and well-formed.
      if (value === "TOO_MANY_IDS")
        value = Array.from(
          { length: LIMITS.participants + 1 },
          (_, i) => `p${i}`,
        );
      if (value === "TOO_MANY_HANDLES")
        value = Array.from(
          { length: LIMITS.participants + 1 },
          (_, i) => `bot-${i}`,
        );
      if (value === "TOO_MANY") {
        let list: unknown = good;
        for (const k of c.path)
          list = (list as Record<string | number, unknown>)[k];
        const items = list as Record<string, unknown>[];
        const limit = MANY[String(c.path.at(-1))];
        if (!limit || !items[0]) throw new Error(`no limit for ${name}`);
        const first = items[0];
        const padded = [
          ...items,
          ...Array.from({ length: limit + 1 - items.length }, (_, i) =>
            "id" in first ? { ...first, id: `${first.id}${i}` } : first,
          ),
        ];
        expect(
          schema.safeParse(setPath(good, c.path, padded.slice(0, limit)))
            .success,
        ).toBe(true);
        value = padded;
      }
      expect(schema.safeParse(setPath(good, c.path, value)).success).toBe(
        false,
      );
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
    for (const s of [
      "plain",
      "tab\there",
      "line\nbreak",
      "café 🍷",
      "☺\ufe0e ❤️",
    ])
      expect(hiddenCharacter(s), s).toBe(false);
    expect(visibleText("a‮b​c\ud800")).toBe("abc�");
    expect(visibleText("🍷🍷🍷", 5)).toBe("🍷🍷");
    expect(hiddenCharacter(visibleText("x⁦y".repeat(3000)))).toBe(false);
    expect(visibleText("x".repeat(LIMITS.text + 10)).length).toBe(LIMITS.text);
  });
});
