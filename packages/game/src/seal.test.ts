import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GAME_RE, HANDLE_RE, MATCH_RE } from "./ids";
import { opens, SALT_RE, SEAL_RE, sealOf } from "./seal";

const fields = ["rps", "m1", "1", "ruby", "rock", "a-salt-of-16-chars"];

describe("sealed moves", () => {
  it("is the sha256 of the fields joined by colons, as a shell makes it", () => {
    const s = sealOf(fields);
    expect(s).toMatch(SEAL_RE);
    // printf 'rps:m1:1:ruby:rock:a-salt-of-16-chars' | sha256sum
    expect(s).toBe(createHash("sha256").update(fields.join(":")).digest("hex"));
  });

  it("opens only with every field the same", () => {
    const s = sealOf(fields);
    expect(opens(s, fields)).toBe(true);
    for (let i = 0; i < fields.length; i++) {
      const other = [...fields];
      other[i] = `${other[i]}x`;
      expect(opens(s, other)).toBe(false);
    }
    expect(opens(s, fields.slice(0, -1))).toBe(false);
  });

  it("can't be shifted between fields", () => {
    // Without a separator check, "ab"+"c" and "a"+"bc" could seal alike.
    expect(() => sealOf(["a:b", "c"])).toThrow();
    expect(sealOf(["ab", "c"])).not.toBe(sealOf(["a", "bc"]));
  });

  it("opens nothing that's malformed", () => {
    const s = sealOf(fields);
    expect(opens(s.toUpperCase(), fields)).toBe(false);
    expect(opens(`${s}0`, fields)).toBe(false);
    expect(opens("", fields)).toBe(false);
    expect(opens(s, [])).toBe(false);
    expect(opens(s, ["", ...fields])).toBe(false);
    expect(() => sealOf([])).toThrow();
  });

  it("takes salts that are long enough and shell-safe", () => {
    expect(SALT_RE.test("a-salt-of-16-chars")).toBe(true);
    expect(SALT_RE.test("short")).toBe(false);
    expect(SALT_RE.test("has:a:colon:in:it")).toBe(false);
    expect(SALT_RE.test("has a space in it!")).toBe(false);
    expect(SALT_RE.test("x".repeat(65))).toBe(false);
  });

  it("seals every id the library accepts", () => {
    // A Table that names a match "chess:42" would get a seal it can't open.
    for (const re of [HANDLE_RE, GAME_RE, MATCH_RE, SALT_RE]) {
      expect(re.test("chess:42"), String(re)).toBe(false);
      expect(re.test(""), String(re)).toBe(false);
    }
    const longest = [
      "a".repeat(30),
      `a${"b".repeat(29)}`,
      `m.${"x".repeat(62)}`,
    ];
    expect(HANDLE_RE.test(longest[0] ?? "")).toBe(true);
    expect(GAME_RE.test(longest[1] ?? "")).toBe(true);
    expect(MATCH_RE.test(longest[2] ?? "")).toBe(true);
    const sealed = [...longest, "1", "rock", "s".repeat(64)];
    expect(opens(sealOf(sealed), sealed)).toBe(true);
  });
});
