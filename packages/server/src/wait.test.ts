import { describe, expect, it } from "vitest";
import { MAX_WAIT, type Probe, waitForNews, waitParam } from "./wait";

const req = (q: string) => new Request(`http://t.test/v1/matches/m_x${q}`);
async function code(f: () => unknown) {
  try {
    await f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "none";
}

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
type A = {
  turn: number;
  phase?: string;
  events: unknown[];
  next: string;
  resync?: boolean;
};
const quiet = (next = "c1.a", phase = "day_talk"): A => ({
  turn: 1,
  phase,
  events: [],
  next,
});
const news: A = { turn: 1, events: [{ kind: "talk" }], next: "c1.z" };

describe("waitParam", () => {
  it("takes whole seconds from 0 to the cap, and refuses the rest", async () => {
    expect(waitParam(req(""))).toBe(0);
    expect(waitParam(req("?wait=0"))).toBe(0);
    expect(waitParam(req("?after=x&wait=25"))).toBe(25);
    expect(MAX_WAIT).toBe(25);
    for (const bad of ["26", "-1", "1.5", "", "abc", "100", "1e1", " 5"])
      expect(
        await code(() => waitParam(req(`?wait=${encodeURIComponent(bad)}`))),
      ).toBe("invalid_wait");
  });
});

describe("waitForNews", () => {
  it("answers at once without a wait, with news, or on a resync", async () => {
    const q = reads([quiet()]);
    expect(await waitForNews(q.read, 0)).toEqual(quiet());
    expect(q.calls()).toBe(1);
    const n = reads([news]);
    expect(await waitForNews(n.read, 5)).toBe(news);
    expect(n.calls()).toBe(1);
    const r = reads([{ ...quiet(), resync: true }]);
    expect((await waitForNews(r.read, 5)).resync).toBe(true);
    expect(r.calls()).toBe(1);
    const whole = reads([{ turn: 1, talk: [], next: "c1.d" }]);
    expect(await waitForNews(whole.read, 5)).toEqual({
      turn: 1,
      talk: [],
      next: "c1.d",
    });
  });

  it("waits only for a player in the match", async () => {
    const r = reads([quiet()]);
    expect(
      await code(() => waitForNews(r.read, 5, { seated: () => false })),
    ).toBe("wait_for_players");
    // Without a wait, anyone reads as before.
    expect(await waitForNews(r.read, 0, { seated: () => false })).toEqual(
      quiet(),
    );
  });

  it("refuses to wait on a match that is over, but gives its last news", async () => {
    const over = reads([quiet("c1.a", "over")]);
    expect(await code(() => waitForNews(over.read, 5))).toBe("match_over");
    expect(over.calls()).toBe(1);
    const ending = reads([{ ...news, phase: "over" }]);
    expect((await waitForNews(ending.read, 5)).events).toHaveLength(1);
  });

  it("waits while nothing it can show changes, then answers the change", async () => {
    // A new cursor alone is not news: each read seals it afresh.
    const r = reads([quiet("c1.a"), quiet("c1.b"), quiet("c1.c"), news]);
    const t = Date.now();
    expect(await waitForNews(r.read, 5, { everyMs: 20 })).toBe(news);
    expect(r.calls()).toBe(4);
    expect(Date.now() - t).toBeLessThan(1000);
    // A change of state with no events (a new turn) is news too.
    const turned = { ...quiet(), turn: 2 };
    const s = reads([quiet(), quiet(), turned]);
    expect(await waitForNews(s.read, 5, { everyMs: 20 })).toBe(turned);
  });

  it("reads again only when the probe moved, a deadline passed, every fifth tick, or at the end", async () => {
    let stamp = "1";
    let due = false;
    let probes = 0;
    const probe = async (): Promise<Probe> => {
      probes++;
      return { stamp, due };
    };
    const r = reads([quiet()]);
    const waited = waitForNews(r.read, 1, { everyMs: 50, probe });
    await new Promise((res) => setTimeout(res, 120));
    // Ticks 1 and 2 have passed with the probe still: no read since the
    // first.
    expect(r.calls()).toBe(1);
    stamp = "2";
    await new Promise((res) => setTimeout(res, 50));
    expect(r.calls()).toBe(2);
    due = true;
    await new Promise((res) => setTimeout(res, 110));
    expect(r.calls()).toBeGreaterThanOrEqual(4);
    due = false;
    await waited;
    // 20 ticks of 50 ms: the first read, the stamp's, the due ones, every
    // fifth tick and the last, never one a tick.
    expect(r.calls()).toBeLessThan(15);
    expect(probes).toBeGreaterThanOrEqual(19);
  });

  it("keeps waiting when the stamp moves but the reader's answer doesn't", async () => {
    // Something hidden from the reader is stored at every tick.
    let n = 0;
    const probe = async (): Promise<Probe> => ({
      stamp: String(n++),
      due: false,
    });
    const r = reads([quiet()]);
    const t = Date.now();
    const a = await waitForNews(r.read, 1, { everyMs: 50, probe });
    expect(a).toEqual(quiet());
    expect(Date.now() - t).toBeGreaterThanOrEqual(990);
  });

  it("answers a flip by the clock at the same moment whatever is hidden", async () => {
    // A quiet answer that changes at a fixed time with no event, as dinner's
    // floor opens, and a stamp that moves at tick 2 in one world only, as a
    // private word between two others would move it.
    const world = async (hidden: boolean) => {
      const t = Date.now();
      let tick = 0;
      const probe = async (): Promise<Probe> => {
        tick++;
        return { stamp: hidden && tick >= 3 ? "2" : "1", due: false };
      };
      const read = async () =>
        Date.now() - t >= 60 ? { ...quiet(), turn: 2 } : quiet();
      const a = await waitForNews(read, 1, { everyMs: 50, probe });
      return { a, took: Date.now() - t };
    };
    const [plain, hidden] = await Promise.all([world(false), world(true)]);
    expect(plain.a).toEqual({ ...quiet(), turn: 2 });
    expect(hidden.a).toEqual(plain.a);
    // Both at the fifth tick, the first read due whatever else happened.
    expect(plain.took).toBeGreaterThanOrEqual(240);
    expect(hidden.took).toBeGreaterThanOrEqual(240);
    expect(Math.abs(plain.took - hidden.took)).toBeLessThan(40);
  });

  it("answers the reader's own news as soon as the stamp moves", async () => {
    let stamp = "1";
    const r = reads([quiet(), news]);
    const probe = async (): Promise<Probe> => ({ stamp, due: false });
    const t = Date.now();
    const waited = waitForNews(r.read, 1, { everyMs: 50, probe });
    setTimeout(() => {
      stamp = "2";
    }, 60);
    expect(await waited).toBe(news);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it("asks the probe before the first read, so news just after it is not late", async () => {
    // The event lands right after the first read: the stamp taken before
    // the read is older, so tick 1 sees it moved.
    let stored = false;
    const calls: string[] = [];
    const probe = async (): Promise<Probe> => {
      calls.push("probe");
      return { stamp: stored ? "2" : "1", due: false };
    };
    let n = 0;
    const read = async () => {
      calls.push("read");
      if (n++ === 0) {
        stored = true;
        return quiet();
      }
      return news;
    };
    const t = Date.now();
    expect(await waitForNews(read, 1, { everyMs: 50, probe })).toBe(news);
    expect(calls.slice(0, 2)).toEqual(["probe", "read"]);
    expect(Date.now() - t).toBeLessThan(200);
    // Without a wait there is no probe at all.
    calls.length = 0;
    await waitForNews(read, 0, { probe });
    expect(calls).toEqual(["read"]);
  });

  it("answers the last quiet read when the time is up, on fixed ticks", async () => {
    const r = reads([quiet("c1.a"), quiet("c1.b")]);
    const t = Date.now();
    const a = await waitForNews(r.read, 1, { everyMs: 100 });
    const took = Date.now() - t;
    expect(a.events).toEqual([]);
    expect(took).toBeGreaterThanOrEqual(990);
    expect(took).toBeLessThan(1300);
    // One read at the start and one at each of the ten ticks.
    expect(r.calls()).toBe(11);
    // A slow read doesn't push the ticks back.
    let n = 0;
    const slow = async () => {
      n++;
      await new Promise((res) => setTimeout(res, 60));
      return quiet();
    };
    const t2 = Date.now();
    await waitForNews(slow, 1, { everyMs: 100 });
    expect(Date.now() - t2).toBeLessThan(1300);
    expect(n).toBe(11);
  });

  it("ends a wait with the last quiet answer when a read fails", async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n === 3) throw new Error("the database went away");
      return quiet(`c1.${n}`);
    };
    const a = await waitForNews(flaky, 5, { everyMs: 20 });
    expect(a).toEqual(quiet("c1.2"));
  });

  it("lets one reader hold at most two waits at once", async () => {
    const r = reads([quiet()]);
    const t = Date.now();
    const held = [1, 2].map(() =>
      waitForNews(r.read, 1, { reader: "mafia\nm_x\nada", everyMs: 100 }),
    );
    await new Promise((res) => setTimeout(res, 10));
    // A third answers at once; another reader still waits.
    await waitForNews(r.read, 1, { reader: "mafia\nm_x\nada" });
    expect(Date.now() - t).toBeLessThan(200);
    const other = waitForNews(r.read, 1, {
      reader: "mafia\nm_x\nbea",
      everyMs: 100,
    });
    await Promise.all([...held, other]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(990);
    // Once they're done, the reader may wait again.
    const t2 = Date.now();
    await waitForNews(r.read, 1, { reader: "mafia\nm_x\nada", everyMs: 100 });
    expect(Date.now() - t2).toBeGreaterThanOrEqual(990);
  });

  it("stops waiting when the platform passes on a hang-up", async () => {
    const r = reads([quiet()]);
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    const t = Date.now();
    await waitForNews(r.read, 20, { everyMs: 1000, signal: c.signal });
    expect(Date.now() - t).toBeLessThan(500);
  });
});
