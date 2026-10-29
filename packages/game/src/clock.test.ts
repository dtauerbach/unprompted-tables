import { describe, expect, it } from "vitest";
import { nextTick, phaseClock, phaseDue, tickClock } from "./clock";

const at = (s: number) => new Date(Date.UTC(2026, 9, 29, 0, 0, s));

describe("clock templates", () => {
  it("gives each phase its own limit from when it opened", () => {
    const c = phaseClock({ commit: 60, reveal: 30 });
    expect(phaseDue(c, "commit", at(5))).toEqual(at(65));
    expect(phaseDue(c, "reveal", at(5))).toEqual(at(35));
    expect(() => phaseDue(c, "chat", at(5))).toThrow(/chat/);
  });

  it("ticks on a fixed schedule", () => {
    const c = tickClock(1);
    expect(nextTick(c, at(0), at(0))).toEqual(at(1));
    expect(nextTick(c, at(0), new Date(at(3).getTime() + 400))).toEqual(at(4));
    expect(nextTick(c, at(10), at(2))).toEqual(at(10));
    const daily = tickClock(86_400);
    expect(nextTick(daily, at(0), at(5)).getTime() - at(0).getTime()).toBe(
      86_400_000,
    );
  });

  it("refuses times that aren't whole positive seconds", () => {
    for (const s of [0, -1, 1.5, Number.NaN]) {
      expect(() => phaseClock({ commit: s })).toThrow(/commit/);
      expect(() => tickClock(s)).toThrow();
    }
  });
});
