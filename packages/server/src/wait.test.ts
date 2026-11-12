import { describe, expect, it } from "vitest";
import { MAX_WAIT, waitForNews, waitParam } from "./wait";

const req = (q: string) => new Request(`http://t.test/v1/matches/m_x${q}`);
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "none";
};

// A read that answers each item of `answers` in turn, the last one again
// once they run out, counting how often it was called.
function reads<T>(answers: T[]) {
  let n = 0;
  const read = async () => {
    const a = answers[Math.min(n, answers.length - 1)] as T;
    n++;
    return a;
  };
  return { read, calls: () => n };
}
const quiet = (next = "c1.a") => ({ turn: 1, events: [], next });

describe("waitParam", () => {
  it("takes whole seconds from 0 to the cap, and refuses the rest", () => {
    expect(waitParam(req(""))).toBe(0);
    expect(waitParam(req("?wait=0"))).toBe(0);
    expect(waitParam(req("?after=x&wait=25"))).toBe(25);
    expect(MAX_WAIT).toBe(25);
    for (const bad of ["26", "-1", "1.5", "", "abc", "100", "1e1", " 5"])
      expect(
        code(() => waitParam(req(`?wait=${encodeURIComponent(bad)}`))),
      ).toBe("invalid_wait");
  });
});

describe("waitForNews", () => {
  it("answers at once without a wait, with news, or on a resync", async () => {
    const q = reads([quiet()]);
    expect(await waitForNews(q.read, 0)).toEqual(quiet());
    expect(q.calls()).toBe(1);
    const news = { turn: 1, events: [{ kind: "talk" }], next: "c1.b" };
    const n = reads([news]);
    expect(await waitForNews(n.read, 5)).toBe(news);
    expect(n.calls()).toBe(1);
    const r = reads([{ turn: 1, resync: true, events: [], next: "c1.c" }]);
    expect((await waitForNews(r.read, 5)).resync).toBe(true);
    expect(r.calls()).toBe(1);
    const whole = reads([{ turn: 1, talk: [], next: "c1.d" }]);
    expect(await waitForNews(whole.read, 5)).toEqual({
      turn: 1,
      talk: [],
      next: "c1.d",
    });
    expect(whole.calls()).toBe(1);
  });

  it("waits while nothing it can show changes, then answers the change", async () => {
    // A new cursor alone is not news: each read seals it afresh.
    const news = { turn: 1, events: [{ kind: "talk" }], next: "c1.z" };
    const r = reads([quiet("c1.a"), quiet("c1.b"), quiet("c1.c"), news]);
    const t = Date.now();
    expect(await waitForNews(r.read, 5, { everyMs: 20 })).toBe(news);
    expect(r.calls()).toBe(4);
    expect(Date.now() - t).toBeLessThan(1000);
    // A change of state with no events (a new turn) is news too.
    const turned = { turn: 2, events: [], next: "c1.y" };
    const s = reads([quiet(), quiet(), turned]);
    expect(await waitForNews(s.read, 5, { everyMs: 20 })).toBe(turned);
  });

  it("answers the last quiet read when the time is up", async () => {
    const r = reads([quiet("c1.a"), quiet("c1.b")]);
    const t = Date.now();
    const a = await waitForNews(r.read, 1, { everyMs: 100 });
    const took = Date.now() - t;
    expect(a.events).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(990);
    expect(took).toBeLessThan(1500);
    expect(r.calls()).toBeGreaterThan(5);
    expect(r.calls()).toBeLessThan(13);
  });

  it("stops waiting when the caller hangs up", async () => {
    const r = reads([quiet()]);
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    const t = Date.now();
    await waitForNews(r.read, 20, { everyMs: 1000, signal: c.signal });
    expect(Date.now() - t).toBeLessThan(500);
  });
});
