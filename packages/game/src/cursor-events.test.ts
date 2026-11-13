import { describe, expect, it } from "vitest";
import { type VisibleEvent, visibleEvents, visibleSince } from "./events";

const ev = (text: string, audience: "public" | string[] = "public") =>
  ({ audience, body: { text } }) as VisibleEvent<{ text: string }>;

describe("delta reads over seat-visible events", () => {
  const log = [
    ev("p1"),
    ev("a1", ["a"]),
    ev("b1", ["b"]),
    ev("b2", ["b"]),
    ev("p2"),
    ev("ab", ["a", "b"]),
    ev("nobody", []),
    ev("p3"),
  ];

  it("counts only what the seat can see, never the stored position", () => {
    expect(visibleSince(log, "a", 0).seen).toBe(5);
    expect(visibleSince(log, "b", 0).seen).toBe(6);
    expect(visibleSince(log, null, 0).seen).toBe(3);
    // After p1 and a1, a's next events are p2, ab, p3: b's private
    // events take no place in a's count.
    expect(visibleSince(log, "a", 2).events.map((e) => e.text)).toEqual([
      "p2",
      "ab",
      "p3",
    ]);
  });

  it("joins up: every split of a seat's reads gives its whole view once", () => {
    for (const seat of ["a", "b", "stranger", null]) {
      const whole = visibleEvents(log, seat);
      for (let at = 0; at <= log.length; at++) {
        const first = visibleSince(log.slice(0, at), seat, 0);
        const rest = visibleSince(log, seat, first.seen);
        expect(rest.resync).toBe(false);
        expect([...first.events, ...rest.events]).toEqual(whole);
      }
    }
  });

  it("a seat's count doesn't move with others' private events", () => {
    const quiet = log.filter(
      (e) => e.audience === "public" || e.audience.includes("a"),
    );
    const busy = [...log, ev("b3", ["b"]), ev("b4", ["b"])];
    expect(visibleSince(busy, "a", 0)).toEqual(visibleSince(log, "a", 0));
    expect(visibleSince(quiet, "a", 0)).toEqual(visibleSince(log, "a", 0));
  });

  it("resyncs a count it can't have given, never skipping or inventing", () => {
    for (const after of [null, 6, 99]) {
      const r = visibleSince(log, "a", after);
      expect(r.resync).toBe(true);
      expect(r.events).toEqual(visibleEvents(log, "a"));
    }
    expect(visibleSince(log, "a", 5)).toEqual({
      events: [],
      seen: 5,
      resync: false,
    });
  });
});
