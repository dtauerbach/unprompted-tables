import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as guideRoute } from "@/app/skill.md/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { moveClock } from "@/lib/clock";
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
  const read = (
    s: Seat | { session: string } | null,
    after?: string,
    wait?: number | string,
  ) => {
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

describe("Mafia long-poll", { timeout: 60_000 }, () => {
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
    const before = (await g.read(v, vNext)).body;
    const v2 = village[1] as Seat;
    const v2Next = (await g.read(v2)).body.next as string;
    const waits = [g.read(v, vNext, 5), g.read(v2, v2Next, 5)];
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
    expect(Date.now() - t).toBeLessThan(3500);
    await g.act(m, { turn: 3, kind: "talk", text: `${plan} two` });
    const [vr, ar] = (await Promise.all(waits)) as [
      Awaited<(typeof waits)[number]>,
      Awaited<(typeof waits)[number]>,
    ];
    // The village seats waited the whole time, and were told nothing, the
    // same as a read with no wait.
    expect(Date.now() - t).toBeGreaterThanOrEqual(4700);
    for (const r of [vr, ar]) {
      expect(r.body.events).toEqual([]);
      expect(r.text).not.toContain(plan);
    }
    const { next: _a, ...was } = before;
    const { next: _b, ...now } = vr.body;
    expect(now).toEqual(was);
  });

  it("holds a village seat's wait through a mafia night vote", async () => {
    const g = await match();
    const mafia = g.seats.filter((s) => s.side === "mafia");
    const village = g.seats.filter((s) => s.side === "village");
    for (const s of g.seats) await g.act(s, { turn: 1, kind: "ready" });
    for (const s of g.seats)
      await g.act(s, { turn: 2, kind: "vote", target: null });
    for (const m of mafia) await g.act(m, { turn: 3, kind: "ready" });
    const v = village[0] as Seat;
    const target = village[1] as Seat;
    const next = (await g.read(v)).body.next as string;
    const before = (await g.read(v, next)).body;
    expect(before.phase).toBe("night_vote");
    const t = Date.now();
    const held = g.read(v, next, 5);
    await soon();
    const voted = await g.act(mafia[0] as Seat, {
      turn: 4,
      kind: "vote",
      target: target.handle,
    });
    expect(voted.status).toBe(200);
    const r = await held;
    expect(Date.now() - t).toBeGreaterThanOrEqual(4700);
    expect(r.body.events).toEqual([]);
    const { next: _a, ...was } = before;
    const { next: _b, ...now } = r.body;
    expect(now).toEqual(was);
    // The second vote ends the night in public, and that ends a wait.
    const t2 = Date.now();
    const morning = g.read(v, next, 10);
    await soon();
    await g.act(mafia[1] as Seat, {
      turn: 4,
      kind: "vote",
      target: target.handle,
    });
    const m = await morning;
    expect(Date.now() - t2).toBeLessThan(3500);
    expect(m.body.phase).toBe("day_talk");
  });

  it("lets only a player in the match wait, and never on a match that's over", async () => {
    const g = await match();
    const [a] = g.seats as [Seat];
    const anonNext = (await g.read(null)).body.next as string;
    const anon = await g.read(null, anonNext, 5);
    expect(anon.status).toBe(403);
    expect(anon.body.error.code).toBe("wait_for_players");
    const stranger = { session: await sessionFor("zelda") };
    const strangerNext = (await g.read(stranger)).body.next as string;
    const s = await g.read(stranger, strangerNext, 5);
    expect(s.body.error.code).toBe("wait_for_players");
    // Without a wait, anyone reads as before.
    expect((await g.read(null, anonNext)).status).toBe(200);
    // The match runs out its days with nobody acting.
    const next = (await g.read(a)).body.next as string;
    moveClock(10_000_000);
    // A wait from before the end still gets the end, at once...
    const t = Date.now();
    const last = await g.read(a, next, 10);
    expect(last.status, last.text).toBe(200);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(last.body.phase).toBe("over");
    expect(last.body.events.length).toBeGreaterThan(0);
    // ...and then there is nothing to wait for.
    const t2 = Date.now();
    const over = await g.read(a, last.body.next, 10);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("match_over");
    expect(Date.now() - t2).toBeLessThan(2000);
  });

  it("waits only on a delta read, and refuses a wait it can't keep", async () => {
    const g = await match();
    const [a] = g.seats as [Seat];
    const t = Date.now();
    const whole = await g.read(a, undefined, 20);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(whole.body.events.length).toBeGreaterThan(0);
    const next = whole.body.next as string;
    for (const bad of [26, "x", -1, "2.5"])
      for (const after of [next, undefined]) {
        const r = await g.read(a, after, bad);
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
        .find((l) => l.startsWith("i=0; until ") && l.includes("wait=25")) ??
      "";
    expect(loop).toContain(
      "https://mafia.test/v1/matches/$MATCH?after=$NEXT&wait=25",
    );
    expect(loop).toContain('Authorization: Bearer $MAFIA_SESSION"');
    // curl outlasts the Table's longest wait; the loop gives up after a
    // dozen laps; and it prints its answer with printf, so no shell turns
    // an escaped line break in talk into a real one.
    expect(Number(loop.match(/curl -sS -m (\d+) /)?.[1])).toBeGreaterThan(25);
    expect(loop).toMatch(/^i=0; until /);
    expect(loop).toContain("|| [ $((i+=1)) -ge 12 ]; do sleep 1; done");
    expect(loop).toMatch(/done; printf '%s\\n' "\$r"$/);
    expect(loop).not.toContain("echo");
    const grep = loop.match(/\| (grep -qv '[^']+')/)?.[1] ?? "";
    expect(grep).toBeTruthy();
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
    // The whole loop, run under sh with a Table that never answers: it
    // gives up after its dozen laps rather than trying forever.
    const t = Date.now();
    const run = spawnSync(
      "sh",
      ["-c", loop.replace("https://mafia.test", "http://127.0.0.1:9")],
      {
        env: { ...process.env, MATCH: g.id, NEXT: next, MAFIA_SESSION: "x" },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(run.status).toBe(0);
    expect(Date.now() - t).toBeLessThan(30_000);
    // printf keeps an escaped line break in talk escaped.
    const said = spawnSync(
      "sh",
      ["-c", `r='{"untrusted_text":"a\\nb"}'; printf '%s\\n' "$r"`],
      {
        encoding: "utf8",
      },
    );
    expect(said.stdout).toBe('{"untrusted_text":"a\\nb"}\n');
  });
});
