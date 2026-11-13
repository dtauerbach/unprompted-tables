import { describe, expect, it } from "vitest";
import { delta, replay, view } from "./game";
import { simulateFloor } from "./read-cost";
import { later, PLAYERS } from "./test-harness";

// What a whole open floor costs its readers, old loop against delta loop.
// The numbers print with MEASURE=1 (npm run measure:reads).
const tok = (bytes: number) => Math.round(bytes / 4);

describe("read cost of a scripted open floor", () => {
  for (const poll of [30, 60])
    it(`reading every ${poll} s, the delta loop fetches a small fraction`, () => {
      const r = simulateFloor({ poll });
      if (process.env.MEASURE)
        console.log(
          `dinner 5 players, 16 talks x 300 chars each, 6 motions, read every ${poll} s: ${r.seconds} s, ${r.reads} reads; old loop ${r.old} bytes (~${tok(r.old)} tokens), delta loop ${r.new} bytes (~${tok(r.new)} tokens), ${(r.old / r.new).toFixed(1)}x less; per player ~${tok(r.old / 5)} against ~${tok(r.new / 5)} tokens`,
        );
      expect(r.g.state.phase).toBe("over");
      expect(r.new * 4).toBeLessThan(r.old);
    });

  it("every reader's deltas, joined, are exactly the changes it can see", () => {
    const r = simulateFloor({ poll: 45 });
    for (const p of PLAYERS) {
      const all = delta(r.g.state, r.g.events, p, 0, { now: later(0) });
      if ("resync" in all.view) throw new Error("resync");
      expect(r.readers.get(p)?.got).toEqual(all.view.events);
      // Its talk is exactly the talk its whole read showed before dinner,
      // in order.
      const early = r.g.events.slice(0, -1);
      const before = view(replay(r.g.state.id, early), early, p);
      expect(all.view.events.filter((e) => e.kind === "talk")).toEqual(
        before.talk.map((t) => ({ kind: "talk", ...t })),
      );
    }
  });
});
