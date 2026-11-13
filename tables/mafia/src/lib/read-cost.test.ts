import { describe, expect, it } from "vitest";
import { simulate } from "./read-cost";

// What a whole match costs its readers, old loop against delta loop. The
// numbers print with MEASURE=1 (npm run measure:reads); the test holds the
// delta loop to a fraction of the old one.
const nine = ["ada", "bea", "cal", "dot", "eve", "fay", "gus", "hal", "ivy"];
// Day 1 the village hangs a villager, the mafia kill one each night, and
// the village finds a mafia on days 2 and 3.
const plan = ["cal", "dot", "ada", "eve", "bea"];

const tok = (bytes: number) => Math.round(bytes / 4);
function report(label: string, r: ReturnType<typeof simulate>) {
  if (process.env.MEASURE)
    console.log(
      `${label}: ${r.days} days, ${r.seconds} s, ${r.reads} reads; old loop ${r.old} bytes (~${tok(r.old)} tokens), delta loop ${r.new} bytes (~${tok(r.new)} tokens), ${(r.old / r.new).toFixed(1)}x less; per player ~${tok(r.old / r.readers.size)} against ~${tok(r.new / r.readers.size)} tokens`,
    );
}

describe("read cost of a scripted 9-player match", () => {
  it("modest talk: the delta loop fetches a small fraction", () => {
    const r = simulate({ players: nine, mafia: ["ada", "bea"], plan });
    report("mafia 9 players, 2 talks x 300 chars, poll 12 s", r);
    expect(r.state.result?.winner).toBe("village");
    expect(r.new * 5).toBeLessThan(r.old);
  });

  it("heavier talk: the gap widens", () => {
    const r = simulate({
      players: nine,
      mafia: ["ada", "bea"],
      plan,
      talk: 4,
      chars: 600,
    });
    report("mafia 9 players, 4 talks x 600 chars, poll 12 s", r);
    expect(r.new * 10).toBeLessThan(r.old);
  });

  it("six players", () => {
    const six = nine.slice(0, 6);
    const r = simulate({
      players: six,
      mafia: ["ada"],
      plan: ["cal", "dot", "ada"],
    });
    report("mafia 6 players, 2 talks x 300 chars, poll 12 s", r);
    expect(r.state.result?.winner).toBe("village");
    expect(r.new * 3).toBeLessThan(r.old);
  });
});
