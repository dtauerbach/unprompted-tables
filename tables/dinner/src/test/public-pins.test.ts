import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  castFor,
  dealFor,
  LEVEL_DEALS,
  servedAfter,
} from "@/lib/floor/generate";
import { DEFAULT_VARIANT, FLOOR_VARIANTS } from "@/lib/floor/variants";

// The room texts (content/lab/) are an experiment kept apart from the public
// game. These pins fail if the public guide or the default game changes, so
// any such change is a deliberate edit here, never a side effect of rooms.

const root = process.cwd();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("the public game is pinned", () => {
  it("serves the same /skill.md", () => {
    expect(
      sha256(readFileSync(path.join(root, "content/skill.md"), "utf8")),
    ).toBe("3f90945e7888882f22ef7f992a5384483a11214265791e018d6e4351ff186061");
  });

  it("deals the same default game", () => {
    expect(DEFAULT_VARIANT).toBe("feud");
    expect(FLOOR_VARIANTS.feud).toEqual({
      game: "floor",
      name: "feud",
      level: "feud",
      floor_opens: 180,
      vote_seconds: 120,
      served: { from: 1500, to: 1860, step: 1 },
      motions_per_assistant: 3,
      messages_per_assistant: 40,
      message_chars: 600,
      no_deal_margin: 3,
      naming: { right: 0, wrong: 0, exposed: 0 },
    });
    expect(LEVEL_DEALS.feud).toEqual({
      likes: [4, 2],
      speaker: [3, 3, 2, 0, 0],
      dislikes: [-5],
      holders: 5,
      unrequited: 2,
      poisoned: 2,
    });
    const seed = "pinned-public-game";
    const d = dealFor(seed, "feud");
    expect(d.weights).toEqual([
      [0, 0, -5, 2, 4, 0],
      [2, 0, 4, -5, 0, 0],
      [4, -5, 0, 2, 0, 3],
      [2, 4, -5, 0, 0, 2],
      [2, 0, -5, 4, 0, 3],
    ]);
    expect(d.secrets).toEqual([[2], [3], [1], [2], [2]]);
    expect(d.tries).toBe(7);
    expect(castFor(seed)).toEqual([2, 0, 3, 4, 1]);
    expect(servedAfter(seed, { from: 1500, to: 1860, step: 1 })).toBe(1580);
  });

  it("serves room text from /seating alone", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    const seating = path.join(root, "src/app/seating");
    const served = files(path.join(root, "src/app")).filter((f) =>
      /lib\/lab|content\/lab/.test(readFileSync(f, "utf8")),
    );
    expect(served).toEqual([path.join(seating, "[[...path]]", "route.ts")]);
    // Nothing else the Table serves reads the rooms' code or texts.
    for (const f of files(path.join(root, "src/lib"))) {
      if (f.includes(`${path.sep}lab${path.sep}`) || f.endsWith(".test.ts"))
        continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /from "\.\/lab|content\/lab/,
      );
    }
  });
});
