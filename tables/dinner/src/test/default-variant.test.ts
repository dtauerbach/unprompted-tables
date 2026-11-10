import { describe, expect, it, vi } from "vitest";

// With no DINNER_VARIANT, a new match plays the standoff with five seats.
vi.hoisted(() => {
  delete process.env.DINNER_VARIANT;
});

import { SETTINGS } from "@/lib/settings";
import { isExecVariant, variantNamed } from "@/lib/variants";

describe("the default variant", () => {
  it("is the standoff, seating exactly five", () => {
    expect(SETTINGS.variant.name).toBe("standoff");
    expect(isExecVariant(SETTINGS.variant)).toBe(true);
    expect(SETTINGS.lobby.min_players).toBe(5);
    expect(SETTINGS.lobby.max_players).toBe(5);
  });

  it("still finds the old party's variants by name", () => {
    const old = variantNamed("classic");
    expect(isExecVariant(old)).toBe(false);
    const scramble = variantNamed("scramble");
    expect(isExecVariant(scramble) && scramble.rule).toBe("majority");
    expect(() => variantNamed("no-such-variant")).toThrow("isn't one of");
    expect(() => variantNamed("toString")).toThrow("isn't one of");
  });
});
