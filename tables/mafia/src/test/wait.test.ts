import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as guideRoute } from "@/app/skill.md/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { call, resetDb, sessionFor } from "./helpers";

// The long-poll: ?after=<next>&wait=N holds a read with nothing new until
// something the reader can see changes. The night stays with the mafia:
// their talk never ends a village seat's wait early.

beforeEach(resetDb);
const handles = ["alice", "bobby", "carol", "david", "ellen", "frank", "grace"];
type Seat = { handle: string; session: string; side: string };

async function match() {
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  for (const s of tokens) await call(queue, { session: s, method: "POST" });
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const seats: Seat[] = [];
  for (const [i, handle] of handles.entries()) {
    const r = await call(getMatch, {
      params: { id },
      session: tokens[i] as string,
    });
    seats.push({ handle, session: tokens[i] as string, side: r.body.you.side });
  }
  const read = (s: Seat | null, after?: string, wait?: number | string) => {
    const q = new URLSearchParams();
    if (after !== undefined) q.set("after", after);
    if (wait !== undefined) q.set("wait", String(wait));
    return call(getMatch, {
      params: { id },
      session: s?.session,
      path: `/v1/matches/${id}?${q}`,
    });
  };
  const act = (s: Seat, body: unknown) =>
    call(action, { params: { id }, session: s.session, body });
  return { id, seats, read, act };
}

// Runs `f` while `p` is pending, then answers p's result and how long it
// took from the start.
async function during<T>(p: Promise<T>, f: () => Promise<unknown>) {
  const t = Date.now();
  await f();
  const r = await p;
  return { r, ms: Date.now() - t };
}
const soon = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("Mafia long-poll", () => {
  it("answers as soon as something the reader can see happens", async () => {
    const g = await match();
    const [a, b] = g.seats as [Seat, Seat];
    const next = (await g.read(a)).body.next as string;
    const { r, ms } = await during(g.read(a, next, 10), async () => {
      await soon();
      await g.act(b, { turn: 1, kind: "talk", text: "hello there" });
    });
    expect(r.status).toBe(200);
    expect(
      r.body.events.map((e: { untrusted_text: string }) => e.untrusted_text),
    ).toEqual(["hello there"]);
    expect(ms).toBeLessThan(4000);
    // A phase change ends a wait too: the new turn's events arrive.
    const turn = r.body.next as string;
    const { r: t } = await during(g.read(a, turn, 10), async () => {
      await soon();
      for (const s of g.seats) await g.act(s, { turn: 1, kind: "ready" });
    });
    expect(t.body.turn).toBe(2);
    expect(t.body.events.length).toBeGreaterThan(0);
  });

  it("answers on time with nothing when nothing it can see happens", async () => {
    const g = await match();
    const [a] = g.seats as [Seat];
    const next = (await g.read(a)).body.next as string;
    const t = Date.now();
    const r = await g.read(a, next, 2);
    const ms = Date.now() - t;
    expect(r.body.events).toEqual([]);
    expect(r.body.resync).toBeUndefined();
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(4000);
  });

  it("holds a village seat's wait through the night's talk", async () => {
    const g = await match();
    const mafia = g.seats.filter((s) => s.side === "mafia");
    const village = g.seats.filter((s) => s.side === "village");
    for (const s of g.seats) await g.act(s, { turn: 1, kind: "ready" });
    for (const s of g.seats)
      await g.act(s, { turn: 2, kind: "vote", target: null });
    const plan = "NIGHTPLAN-quietly";
    const v = village[0] as Seat;
    const m = mafia[0] as Seat;
    const vNext = (await g.read(v)).body.next as string;
    const mNext = (await g.read(m)).body.next as string;
    const anonNext = (await g.read(null)).body.next as string;
    const before = (await g.read(v, vNext)).body;
    const waits = [g.read(v, vNext, 3), g.read(null, anonNext, 3)];
    const mWait = g.read(m, mNext, 10);
    const t = Date.now();
    await soon();
    await g.act(mafia[1] as Seat, {
      turn: 3,
      kind: "talk",
      text: `${plan} one`,
    });
    // The mafia's wait ends with the talk.
    const mr = await mWait;
    expect(mr.text).toContain(plan);
    expect(Date.now() - t).toBeLessThan(2500);
    await g.act(m, { turn: 3, kind: "talk", text: `${plan} two` });
    const [vr, ar] = (await Promise.all(waits)) as [
      Awaited<(typeof waits)[number]>,
      Awaited<(typeof waits)[number]>,
    ];
    // The village seat and the public reader waited the whole time, and
    // were told nothing, the same as a read with no wait.
    expect(Date.now() - t).toBeGreaterThanOrEqual(2700);
    for (const r of [vr, ar]) {
      expect(r.body.events).toEqual([]);
      expect(r.text).not.toContain(plan);
    }
    const { next: _a, ...was } = before;
    const { next: _b, ...now } = vr.body;
    expect(now).toEqual(was);
  });

  it("waits only on a delta read, and refuses a wait it can't keep", async () => {
    const g = await match();
    const [a] = g.seats as [Seat];
    const t = Date.now();
    const whole = await g.read(a, undefined, 20);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(whole.body.events.length).toBeGreaterThan(0);
    const next = whole.body.next as string;
    for (const bad of [26, "x", -1, "2.5"]) {
      const r = await g.read(a, next, bad);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_wait");
    }
    // A forged cursor is a resync: answered at once, nothing to wait for.
    const t2 = Date.now();
    const f = await g.read(a, "c1.forged", 20);
    expect(f.body.resync).toBe(true);
    expect(Date.now() - t2).toBeLessThan(2000);
  });

  it("gives a shell loop that waits in the match without a model turn per check", async () => {
    const guide = await (
      await guideRoute(new Request("https://mafia.test/skill.md"))
    ).text();
    const loop =
      guide
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("until ") && l.includes("wait=25")) ?? "";
    expect(loop).toContain(
      "https://mafia.test/v1/matches/$MATCH?after=$NEXT&wait=25",
    );
    expect(loop).toContain('Authorization: Bearer $MAFIA_SESSION"');
    // curl outlasts the Table's longest wait, and the loop prints its answer.
    expect(Number(loop.match(/curl -sS -m (\d+) /)?.[1])).toBeGreaterThan(25);
    expect(loop).toMatch(/done; echo "\$r"$/);
    const grep = loop.match(/\| (grep [^;]+); do/)?.[1] ?? "";
    const done = (text: string) =>
      spawnSync("bash", ["-c", grep], { input: text }).status === 0;
    // Run on the very text the Table sends: a quiet wait keeps it going,
    // anything to read, a resync or an error stops it.
    const g = await match();
    const [a, b] = g.seats as [Seat, Seat];
    const next = (await g.read(a)).body.next as string;
    const quiet = await g.read(a, next, 1);
    expect(quiet.body.events).toEqual([]);
    expect(done(quiet.text)).toBe(false);
    await g.act(b, { turn: 1, kind: "talk", text: "anyone there" });
    expect(done((await g.read(a, next, 1)).text)).toBe(true);
    expect(done((await g.read(a, "c1.lost", 1)).text)).toBe(true);
    expect(done((await g.read(a, next, 99)).text)).toBe(true);
    expect(spawnSync("bash", ["-c", grep], { input: "" }).status).not.toBe(0);
  });
});
