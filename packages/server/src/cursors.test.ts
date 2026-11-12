import { afterEach, describe, expect, it } from "vitest";
import { afterParam, cursorScope, openCursor, sealCursor } from "./cursors";

const scope = cursorScope("mafia", "m_abcdefghijkl", "alice");

describe("read cursors", () => {
  const secret = process.env.IP_HASH_SECRET;
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (secret === undefined) delete process.env.IP_HASH_SECRET;
    else process.env.IP_HASH_SECRET = secret;
    (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
  });

  it("opens to the count it sealed, for its own scope only", () => {
    for (const n of [0, 1, 37, 4_000_000_000]) {
      const c = sealCursor(scope, n);
      expect(c).toMatch(/^c1\.[A-Za-z0-9_-]{43}$/);
      expect(openCursor(scope, c)).toBe(n);
      for (const other of [
        cursorScope("mafia", "m_abcdefghijkl", "bobby"),
        cursorScope("mafia", "m_abcdefghijkl", null),
        cursorScope("mafia", "m_abcdefghijkm", "alice"),
        cursorScope("dinner", "m_abcdefghijkl", "alice"),
      ])
        expect(openCursor(other, c)).toBeNull();
    }
  });

  it("hides the count: same length, and two seals of one count differ", () => {
    const a = sealCursor(scope, 3);
    const b = sealCursor(scope, 3);
    const c = sealCursor(scope, 300_000);
    expect(a).not.toBe(b);
    expect(a.length).toBe(c.length);
  });

  it("refuses anything changed, made up or sealed under another secret", () => {
    const c = sealCursor(scope, 12);
    const raw = Buffer.from(c.slice(3), "base64url");
    for (let i = 0; i < raw.length; i++) {
      const flipped = Buffer.from(raw);
      flipped[i] = (flipped[i] as number) ^ 1;
      expect(
        openCursor(scope, `c1.${flipped.toString("base64url")}`),
      ).toBeNull();
    }
    for (const junk of [
      "",
      "12",
      "c1.",
      "c1.!!!",
      `c2.${c.slice(3)}`,
      c.slice(0, -1),
      `${c}A`,
    ])
      expect(openCursor(scope, junk)).toBeNull();
    process.env.IP_HASH_SECRET = "another";
    expect(openCursor(scope, c)).toBeNull();
  });

  it("won't seal in production without the secret", () => {
    delete process.env.IP_HASH_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(() => sealCursor(scope, 1)).toThrow(/IP_HASH_SECRET/);
  });

  it("reads after from the query, refusing one far too long", () => {
    const r = (q: string) => new Request(`http://t.test/v1/matches/m${q}`);
    expect(afterParam(r(""))).toBeUndefined();
    expect(afterParam(r("?after="))).toBe("");
    expect(afterParam(r("?after=c1.abc"))).toBe("c1.abc");
    expect(() => afterParam(r(`?after=${"x".repeat(201)}`))).toThrow(
      expect.objectContaining({ code: "invalid_cursor" }),
    );
  });
});
