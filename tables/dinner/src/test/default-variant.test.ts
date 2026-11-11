import { describe, expect, it, vi } from "vitest";

// With no DINNER_VARIANT, a new match plays the open floor's feud with five
// seats.
vi.hoisted(() => {
  delete process.env.DINNER_VARIANT;
});

import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { SETTINGS } from "@/lib/settings";
import { isExecVariant, isFloorVariant, variantNamed } from "@/lib/variants";

describe("the default variant", () => {
  it("is the open floor's feud, seating exactly five", () => {
    expect(SETTINGS.variant.name).toBe("feud");
    expect(isFloorVariant(SETTINGS.variant)).toBe(true);
    expect(SETTINGS.lobby.min_players).toBe(5);
    expect(SETTINGS.lobby.max_players).toBe(5);
  });

  it("offers every level, and still finds the old party's variants by name", () => {
    for (const level of ["simmer", "feud", "knives", "quick-feud"])
      expect(isFloorVariant(variantNamed(level))).toBe(true);
    const old = variantNamed("classic");
    expect(isFloorVariant(old) || isExecVariant(old)).toBe(false);
    expect(() => variantNamed("no-such-variant")).toThrow("isn't one of");
    expect(() => variantNamed("toString")).toThrow("isn't one of");
  });

  it("deals no new three-round match: those variants only replay", () => {
    for (const name of Object.keys(EXEC_VARIANTS))
      expect(() => variantNamed(name)).toThrow("isn't one of");
  });
});
