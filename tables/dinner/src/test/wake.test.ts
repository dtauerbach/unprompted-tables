import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The executive game with short clocks (0, 60 and 30 seconds), set before
// any module reads it.
vi.hoisted(() => {
  process.env.DINNER_VARIANT = "quick-compromise";
});

import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { moveClock, now } from "@/lib/clock";
import { EXECUTIVES, start as startExec } from "@/lib/exec/game";
import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { start as startParty } from "@/lib/match";
import type { AnyEvent } from "@/lib/rules";
import { sweep } from "@/lib/store";
import { VARIANTS } from "@/lib/variants";
import {
  BACKOFF_MS,
  choose,
  FAILED_PAUSE_MS,
  NUDGE_BUDGET,
  NUDGE_LOCK,
  resetBackoff,
  setWakeRunner,
  wakesFor,
} from "@/lib/wake";
import { call, fakeSite, holderOf, join, resetDb, sessionFor } from "./helpers";

// A player that asked Unprompted for its pass with wake on lets this Table
// raise its wake number when its match needs it: at the start, at each
// filing (the voters), at each close and the end (everyone), and for
// private talk to it. Never for its own move, never twice before it reads
// the match again, never once its leave is over, and within a budget no
// one player can spend.

const handles = ["alice", "bobby", "carol", "david", "ellen"];

let jobs: (() => Promise<void>)[] = [];
let restoreRunner: () => void = () => {};
let nudged: { to: string; ref?: string }[] = [];
let siteAnswer: (to: string) => Response | Promise<Response> = () =>
  Response.json({ nudged: {} });
const budget = { ...NUDGE_BUDGET };

beforeEach(async () => {
  await resetDb();
  resetBackoff();
  jobs = [];
  nudged = [];
  siteAnswer = () => Response.json({ nudged: {} });
  restoreRunner = setWakeRunner((job) => jobs.push(job));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://unprompted.test/v1/nudges");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${process.env.UNPROMPTED_KEY}`,
    );
    const body = JSON.parse(String(init?.body));
    nudged.push(body);
    return siteAnswer(body.to);
  });
});
afterEach(() => {
  Object.assign(NUDGE_BUDGET, budget);
  delete process.env.TABLE_READ_ONLY;
  restoreRunner();
  vi.restoreAllMocks();
});

// Sends what's been chosen, as the response's after() would, and says who
// was nudged, in name order.
async function flush(): Promise<string[]> {
  const run = jobs;
  jobs = [];
  for (const job of run) await job();
  const to = nudged.map((n) => n.to).sort();
  nudged = [];
  return to;
}

async function letWake(who: string[], until = "1 day") {
  await db()`INSERT INTO wake_leave (player, until)
    SELECT h, now() + ${until}::interval FROM unnest(${who}::text[]) AS h`;
}

const all = (...but: string[]) => handles.filter((h) => !but.includes(h));

async function match(wake: string[] = handles) {
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  await letWake(wake);
  for (const s of tokens) await call(queue, { session: s, method: "POST" });
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const seat = (h: string) => tokens[handles.indexOf(h)] as string;
  // A watcher's look: no session, so it marks nobody as having read.
  const look = async () => (await call(getMatch, { params: { id } })).body;
  const first = await look();
  const execOf = new Map<string, string>(
    first.table.executives.map(
      (e: { executive: string; assistant: string }) => [
        e.assistant,
        e.executive,
      ],
    ),
  );
  const byExec = new Map([...execOf].map(([h, x]) => [x, h]));
  const read = (h: string) =>
    call(getMatch, { params: { id }, session: seat(h) });
  const readAll = async (...but: string[]) => {
    for (const h of all(...but)) await read(h);
  };
  const act = (h: string, body: unknown) =>
    call(action, { params: { id }, session: seat(h), body });
  const talk = (h: string, text = "hello", to?: string[]) =>
    act(h, {
      kind: "talk",
      text,
      ...(to ? { to: to.map((x) => execOf.get(x)) } : {}),
    });
  const proposer = async () =>
    byExec.get((await look()).round.proposer) as string;
  const file = (h: string, round = 1) =>
    act(h, { kind: "propose", round, seating: EXECUTIVES });
  const vote = (h: string, ballot: "yes" | "no", round = 1) =>
    act(h, { kind: "vote", round, ballot });
  return { id, seat, look, read, readAll, act, talk, proposer, file, vote };
}

describe("who an event wakes", () => {
  const at = new Date("2026-11-10T12:00:00.000Z");
  const execStart = startExec(
    handles,
    EXEC_VARIANTS["quick-compromise"] as NonNullable<
      (typeof EXEC_VARIANTS)["quick-compromise"]
    >,
    at,
    "wakes",
  ) as AnyEvent[];
  const ev = (body: Record<string, unknown>, audience: unknown = "public") =>
    ({ body: { at: at.toISOString(), ...body }, audience }) as AnyEvent;

  it("wakes everyone for the start, a round, and the end", () => {
    expect(wakesFor(handles, execStart, true).game.sort()).toEqual(handles);
    for (const body of [
      { kind: "round", phase: "open", round: 2, proposer: "Avery" },
      { kind: "round", phase: "close", round: 1, seating: null },
      { kind: "end", how: "deal" },
    ])
      expect(wakesFor(handles, [ev(body)], true).game.sort()).toEqual(handles);
  });

  it("wakes the voters for a filing, and nobody for a ballot or public talk", () => {
    const filed = wakesFor(
      handles,
      [ev({ kind: "propose", player: "carol", round: 1, seating: EXECUTIVES })],
      true,
    );
    expect(filed.game.sort()).toEqual(all("carol"));
    const quiet = wakesFor(
      handles,
      [
        ev({ kind: "back", player: "bobby", round: 1, ballot: "no" }, [
          "bobby",
        ]),
        ev({ kind: "talk", player: "bobby", text: "hi" }),
      ],
      true,
    );
    expect(quiet.game).toEqual([]);
    expect(quiet.talk.size).toBe(0);
  });

  it("wakes the recipients of private talk, charged to the talker", () => {
    const w = wakesFor(
      handles,
      [
        ev({ kind: "talk", player: "bobby", text: "psst", to: ["X", "Y"] }, [
          "bobby",
          "carol",
          "ellen",
        ]),
        ev({ kind: "talk", player: "bobby", text: "and", to: ["Z"] }, [
          "bobby",
          "david",
        ]),
      ],
      true,
    );
    expect(w.game).toEqual([]);
    expect([...w.talk]).toEqual([["bobby", ["carol", "ellen", "david"]]]);
  });

  it("wakes the first party's guests only at its start and end", () => {
    const events = startParty(
      handles,
      VARIANTS.quick as NonNullable<typeof VARIANTS.quick>,
      at,
      "party",
    ) as AnyEvent[];
    expect(wakesFor(handles, events, false).game.sort()).toEqual(handles);
    const moves = wakesFor(
      handles,
      [
        ev({ kind: "talk", player: "alice", text: "hi" }),
        ev({ kind: "propose", player: "alice", id: "P1", seating: [] }),
        ev({ kind: "back", player: "bobby", proposal: "P1" }),
      ],
      false,
    );
    expect(moves.game).toEqual([]);
    expect(moves.talk.size).toBe(0);
  });
});

describe("waking players through a match", () => {
  it("wakes every assistant with leave once when the match starts, with the match id", async () => {
    const g = await match(["alice", "bobby", "carol"]);
    expect(g.id).toMatch(/^m_/);
    // Once each: the first round's opening comes with the start.
    expect(await flush()).toEqual(["alice", "bobby", "carol"]);
  });

  it("sends only the handle and the match id", async () => {
    const g = await match(["alice"]);
    for (const job of jobs) await job();
    expect(nudged).toEqual([{ to: "alice", ref: g.id }]);
  });

  it("wakes the four voters when the seating is filed, never the proposer", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    expect((await g.file(p)).status).toBe(200);
    expect(await flush()).toEqual(all(p));
  });

  it("wakes nobody for a ballot that doesn't close the round, or for public talk", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    await g.file(p);
    await flush();
    await g.readAll();
    const [v1] = all(p) as [string];
    expect((await g.vote(v1, "yes")).status).toBe(200);
    expect((await g.talk(v1, "to the table")).status).toBe(200);
    expect(await flush()).toEqual([]);
  });

  it("wakes everyone but the last voter when the fourth ballot closes the round", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    await g.file(p);
    await flush();
    const voters = all(p);
    for (const v of voters.slice(0, 3)) await g.vote(v, "yes");
    await g.readAll();
    await flush();
    const last = voters[3] as string;
    // A no under unanimity: the round fails and the next opens.
    const closed = await g.vote(last, "no");
    expect(closed.body.rounds).toHaveLength(1);
    expect(closed.body.round.number).toBe(2);
    expect(await flush()).toEqual(all(last));
  });

  it("wakes everyone but the last voter when a seating passes and the match ends", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    await g.file(p);
    const voters = all(p);
    for (const v of voters.slice(0, 3)) await g.vote(v, "yes");
    await g.readAll();
    await flush();
    const last = voters[3] as string;
    expect((await g.vote(last, "yes")).body.phase).toBe("over");
    expect(await flush()).toEqual(all(last));
  });

  it("wakes everyone but the reader when a read finds voting time run out", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    await g.file(p);
    await flush();
    await g.readAll();
    moveClock(31_000);
    const seen = await g.read("david");
    expect(seen.body.rounds).toHaveLength(1);
    expect(await flush()).toEqual(all("david"));
  });

  it("wakes everyone when the sweep closes a round nobody filed in", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    moveClock(61_000);
    await sweep();
    expect((await g.look()).round.number).toBe(2);
    expect(await flush()).toEqual(handles);
  });

  it("wakes the recipients of private talk, and only them", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    expect(
      (await g.talk("alice", "between us", ["bobby", "ellen"])).status,
    ).toBe(200);
    expect(await flush()).toEqual(["bobby", "ellen"]);
  });

  it("wakes a player once until it reads the match again", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    await g.talk("alice", "one", ["bobby", "carol"]);
    await g.talk("david", "two", ["bobby", "carol"]);
    expect(await flush()).toEqual(["bobby", "carol"]);
    await g.read("bobby");
    await g.talk("david", "three", ["bobby", "carol"]);
    expect(await flush()).toEqual(["bobby"]);
    // A player's own move counts as reading.
    await g.talk("carol", "four", ["alice"]);
    await g.talk("david", "five", ["carol"]);
    expect(await flush()).toEqual(["alice", "carol"]);
  });

  it("leaves out players without leave, or whose leave ran out", async () => {
    const g = await match(["alice", "bobby"]);
    await flush();
    await db()`UPDATE wake_leave SET until = now() - interval '1 minute'
      WHERE player = 'bobby'`;
    await g.readAll();
    await g.talk("carol", "hi", ["alice", "bobby", "david"]);
    expect(await flush()).toEqual(["alice"]);
  });

  it("wakes nobody for a move that was refused", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    const voter = all(p)[0] as string;
    const bad = await g.vote(voter, "yes");
    expect(bad.status).toBe(409);
    const wrong = await g.file(voter);
    expect(wrong.status).toBe(409);
    expect(await flush()).toEqual([]);
  });

  it("stops waking a player the site says it can't wake", async () => {
    const g = await match(["alice", "bobby"]);
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json(
            { error: { code: "cant_wake", message: "no" } },
            { status: 403 },
          )
        : Response.json({ nudged: {} });
    await flush();
    const left = await db()`SELECT 1 FROM wake_leave WHERE player = 'bobby'`;
    expect(left).toHaveLength(0);
    await g.readAll();
    await g.talk("carol", "hi", ["alice", "bobby"]);
    expect(await flush()).toEqual(["alice"]);
  });

  it("keeps the match going when the site is down or limits it", async () => {
    const g = await match(["alice", "bobby"]);
    siteAnswer = (to) =>
      to === "alice"
        ? Response.json({}, { status: 429 })
        : Response.json({}, { status: 500 });
    await flush();
    const p = await g.proposer();
    expect((await g.file(p)).status).toBe(200);
    expect((await g.talk("carol", "still here")).status).toBe(200);
    // A limited or failed nudge keeps the leave.
    const rows = await db()<{ player: string }[]>`
      SELECT player FROM wake_leave ORDER BY player`;
    expect(rows.map((r) => r.player)).toEqual(["alice", "bobby"]);
  });
});

describe("when nudges go wrong", () => {
  it("waits for the write that chose the nudges, and sends none if it rolls back", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const wakes = { game: handles, talk: new Map<string, string[]>() };
    for (const outcome of ["commit", "rollback"] as const) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const write = db()
        .begin(async (sql) => {
          await choose(sql, g.id, wakes, "alice", now());
          await gate;
          if (outcome === "rollback") throw new Error("rolled back");
        })
        .catch(() => {});
      await vi.waitFor(() => expect(jobs).toHaveLength(1));
      // The response went out before the write committed.
      const sending = flush();
      await new Promise((r) => setTimeout(r, 150));
      expect(nudged, outcome).toEqual([]);
      release();
      await write;
      expect(await sending, outcome).toEqual(
        outcome === "commit" ? all("alice") : [],
      );
      await g.readAll();
    }
  });

  it("wakes again on the next event after the site fails, once the pause is over", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    siteAnswer = () => Response.json({}, { status: 500 });
    await g.talk("alice", "one", ["bobby", "carol"]);
    expect(await flush()).toEqual(["bobby", "carol"]);
    siteAnswer = () => Response.json({ nudged: {} });
    // A failure pauses choosing for a few seconds, so an outage doesn't
    // spend the players' budget on tries.
    await g.talk("alice", "two", ["bobby", "carol"]);
    expect(await flush()).toEqual([]);
    moveClock(FAILED_PAUSE_MS + 1000);
    // Nobody was woken, so the next talk wakes them.
    await g.talk("alice", "three", ["bobby", "carol"]);
    expect(await flush()).toEqual(["bobby", "carol"]);
  });

  it("chooses nobody for a minute after the site says the Table is over a limit", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json({ error: { code: "rate_limited" } }, { status: 429 })
        : Response.json({ nudged: {} });
    await g.talk("alice", "one", ["bobby", "carol"]);
    expect(await flush()).toEqual(["bobby", "carol"]);
    siteAnswer = () => Response.json({ nudged: {} });
    await g.talk("david", "two", ["alice", "ellen"]);
    expect(await flush()).toEqual([]);
    moveClock(BACKOFF_MS + 1000);
    // A minute on, filing time has run out too, so ellen's talk closes the
    // round and wakes everyone but her and carol, who was woken and hasn't
    // read. bobby, never woken, is woken now.
    await g.talk("ellen", "three", ["alice", "bobby", "carol"]);
    expect(await flush()).toEqual(["alice", "bobby", "david"]);
  });

  it("keeps the minute's pause when a failure lands after a 429", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    siteAnswer = async (to) => {
      if (to === "bobby") return Response.json({}, { status: 429 });
      if (to === "carol") {
        await new Promise((r) => setTimeout(r, 50));
        return Response.json({}, { status: 500 });
      }
      return Response.json({ nudged: {} });
    };
    await g.talk("alice", "one", ["bobby", "carol"]);
    await flush();
    siteAnswer = () => Response.json({ nudged: {} });
    moveClock(FAILED_PAUSE_MS + 1000);
    await g.readAll();
    await g.talk("alice", "six seconds later", ["bobby", "carol"]);
    expect(await flush()).toEqual([]);
  });

  it("ends only the leave the refused nudge went on", async () => {
    await match(["alice", "bobby"]);
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json({ error: { code: "cant_wake" } }, { status: 403 })
        : Response.json({ nudged: {} });
    // bobby gives a new pass before the refused nudge comes back.
    await db()`UPDATE wake_leave SET until = now() + interval '20 hours'
      WHERE player = 'bobby'`;
    await flush();
    const left = await db()`SELECT 1 FROM wake_leave WHERE player = 'bobby'`;
    expect(left).toHaveLength(1);
  });

  it("marks a read only for a real match, and not while the Table is read-only", async () => {
    const g = await match();
    await flush();
    for (const id of ["m_<nope>", "m_\u0000aaaaaaaaaaa"]) {
      const bad = await call(getMatch, {
        params: { id },
        session: g.seat("alice"),
      });
      expect(bad.status).toBe(404);
    }
    // alice was woken at the start and hasn't read; a read-only read
    // doesn't count, so private talk to her doesn't wake her again.
    process.env.TABLE_READ_ONLY = "1";
    expect((await g.read("alice")).status).toBe(200);
    delete process.env.TABLE_READ_ONLY;
    await g.read("carol");
    await g.talk("bobby", "hi", ["alice", "carol"]);
    expect(await flush()).toEqual(["carol"]);
  });

  it("holds a waiting player's read until a move in progress commits, so the read shows it", async () => {
    const g = await match();
    await flush();
    // bobby was woken at the start and hasn't read; carol has.
    await g.read("carol");
    // Hold a budget row, so alice's talk stops inside choose(): a write
    // that takes a while to commit.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held: () => void = () => {};
    const isHeld = new Promise<void>((r) => {
      held = r;
    });
    const holding = db().begin(async (sql) => {
      await sql`UPDATE rate_limits SET count = count WHERE bucket LIKE 'nudge:%'`;
      held();
      await gate;
    });
    await isHeld;
    const moving = g.talk("alice", "said while bobby reads", [
      "bobby",
      "carol",
    ]);
    await vi.waitFor(async () => {
      const waiting = await db()`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(waiting).toHaveLength(1);
    });
    const reading = g.read("bobby");
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holding;
    const [seen, moved] = await Promise.all([reading, moving]);
    expect(moved.status).toBe(200);
    const saw = (seen.body.talk as { untrusted_text: string }[]).some(
      (t) => t.untrusted_text === "said while bobby reads",
    );
    // What a player's read doesn't show, the player is woken for.
    expect(saw || (await flush()).includes("bobby")).toBe(true);
  });
});

describe("the Table-wide budgets", () => {
  it("are counted one write at a time, and only by writes that wake someone", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held: () => void = () => {};
    const isHeld = new Promise<void>((r) => {
      held = r;
    });
    const holding = db().begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${NUDGE_LOCK})`;
      held();
      await gate;
    });
    await isHeld;
    // Talk to the table wakes nobody, so it goes straight through.
    expect((await g.talk("alice", "to the table")).status).toBe(200);
    const moving = g.talk("alice", "psst", ["bobby"]);
    await vi.waitFor(async () => {
      const waiting = await db()`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event = 'advisory'`;
      expect(waiting).toHaveLength(1);
    });
    release();
    await holding;
    expect((await moving).status).toBe(200);
    expect(await flush()).toEqual(["bobby"]);
  });
});

describe("the budget", () => {
  const counts = async () =>
    Object.fromEntries(
      (
        await db()<{ bucket: string; count: number }[]>`
          SELECT bucket, count FROM rate_limits WHERE bucket LIKE 'nudge:%'`
      ).map((r) => [r.bucket.replace(/m_[A-Za-z0-9_-]{12}/, "M"), r.count]),
    );

  it("counts a match's own wakes against the match, never the player whose move set them off", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    const p = await g.proposer();
    await g.file(p);
    await flush();
    const c = await counts();
    expect(c["nudge:match:M"]).toBe(9);
    expect(c["nudge:all"]).toBe(9);
    expect(c[`nudge:to:${p}`]).toBe(1);
    for (const v of all(p)) expect(c[`nudge:to:${v}`]).toBe(2);
    expect(Object.keys(c).some((k) => k.startsWith("nudge:talk"))).toBe(false);
  });

  it("counts private talk against the talker, the recipient, and the Table's talk share", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    await g.talk("alice", "hi", ["bobby", "carol"]);
    await flush();
    const c = await counts();
    expect(c).toMatchObject({
      "nudge:talk:from:alice": 2,
      "nudge:talk:to:bobby": 1,
      "nudge:talk:to:carol": 1,
      "nudge:talk": 2,
      "nudge:all": 7,
      "nudge:match:M": 5,
      "nudge:to:bobby": 2,
    });
  });

  it("spends no budget on a player already waiting", async () => {
    const g = await match(["alice", "bobby"]);
    await flush();
    await g.read("alice");
    await g.talk("carol", "one", ["alice", "bobby"]);
    await g.talk("david", "two", ["alice", "bobby"]);
    expect(await flush()).toEqual(["alice"]);
    const c = await counts();
    // bobby was woken at the start and hasn't read: one nudge, not three.
    expect(c["nudge:to:bobby"]).toBe(1);
    expect(c["nudge:to:alice"]).toBe(2);
    expect(c["nudge:all"]).toBe(3);
  });

  it("stops one talker at its share, and others' talk still wakes", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    NUDGE_BUDGET.talkPerSender = 2;
    for (const text of ["one", "two", "three"]) {
      await g.talk("alice", text, ["bobby"]);
      await g.read("bobby");
    }
    expect(await flush()).toEqual(["bobby", "bobby"]);
    await g.talk("carol", "mine", ["bobby"]);
    expect(await flush()).toEqual(["bobby"]);
  });

  it("keeps each player's hour for the match, however much talk comes its way", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    // Start: one each. Talk may add two to a player; four in all leaves one
    // for the filing.
    NUDGE_BUDGET.talkPerPlayer = 2;
    NUDGE_BUDGET.perPlayer = 4;
    const p = await g.proposer();
    const victim = all(p)[0] as string;
    for (const t of all(victim)) {
      await g.talk(t, "psst", [victim]);
      await g.read(victim);
    }
    expect(await flush()).toEqual([victim, victim]);
    await g.file(p);
    expect(await flush()).toContain(victim);
  });

  it("leaves room for the others' round wakes when one player tries to spend the Table's hour", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    // Start: 5. A round's filing and close: at most 9 more. Talk gets 4 of
    // the Table's 18, however much it tries.
    NUDGE_BUDGET.perTable = 18;
    NUDGE_BUDGET.talkPerTable = 4;
    NUDGE_BUDGET.talkPerSender = 100;
    NUDGE_BUDGET.talkPerPlayer = 100;
    const p = await g.proposer();
    const griefer = all(p)[0] as string;
    let woken = 0;
    for (let i = 0; i < 10; i++) {
      await g.talk(griefer, `spam ${i}`, all(griefer));
      woken += (await flush()).length;
      await g.readAll(griefer);
    }
    expect(woken).toBe(4);
    await g.file(p);
    expect(await flush()).toEqual(all(p));
    await g.readAll();
    const voters = all(p);
    for (const v of voters.slice(0, 3)) await g.vote(v, "yes");
    const last = voters[3] as string;
    await g.vote(last, "no");
    expect(await flush()).toEqual(all(last));
  });

  it("caps a match's own wakes", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    NUDGE_BUDGET.perMatch = 5;
    const g = await match();
    expect(await flush()).toEqual(handles);
    await g.readAll();
    await g.file(await g.proposer());
    expect(await flush()).toEqual([]);
    expect(lines.map((l) => JSON.parse(l).operation)).toEqual([
      "nudge_budget_match",
    ]);
  });

  it("counts nothing against the players a full Table didn't wake, and logs each spent budget once", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const ops = () =>
      lines
        .map((l) => JSON.parse(l) as { operation?: string })
        .map((l) => l.operation);
    const g = await match();
    await flush();
    await g.readAll();
    // Starting the match spent one per player and five for the Table.
    NUDGE_BUDGET.perTable = 5;
    await g.talk("alice", "one", ["bobby", "carol"]);
    await g.talk("david", "two", ["bobby", "carol"]);
    expect(await flush()).toEqual([]);
    expect(ops()).toEqual(["nudge_budget_table"]);
    const c = await counts();
    expect(c["nudge:to:bobby"]).toBe(1);
    expect(c["nudge:talk:to:bobby"] ?? 0).toBe(0);
    expect(c["nudge:talk:from:alice"] ?? 0).toBe(0);
    NUDGE_BUDGET.perTable = 100;
    NUDGE_BUDGET.perPlayer = 1;
    await g.talk("ellen", "three", ["bobby", "carol"]);
    expect(await flush()).toEqual([]);
    expect(ops().filter((o) => o === "nudge_budget_player")).toHaveLength(2);
    NUDGE_BUDGET.perPlayer = 100;
    lines.length = 0;
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json({}, { status: 429 })
        : Response.json({}, { status: 500 });
    await g.talk("david", "four", ["bobby", "carol"]);
    await flush();
    expect(new Set(ops())).toEqual(new Set(["nudge_limited", "nudge_failed"]));
  });
});

describe("leave from the pass", () => {
  it("is kept from the site's answer, and a later pass without wake doesn't end it", async () => {
    vi.restoreAllMocks();
    const site = fakeSite();
    try {
      const until = new Date(Date.now() + 86_400_000).toISOString();
      site.setAnswer((handle) => ({
        bot: holderOf(handle),
        wake_until: until,
      }));
      await join(site, "alice");
      site.setAnswer((handle) => ({ bot: holderOf(handle), wake_until: null }));
      await join(site, "alice");
      // An older site that doesn't send wake_until, or sends junk.
      site.setAnswer((handle) => ({ bot: holderOf(handle) }));
      await join(site, "bobby");
      site.setAnswer((handle) => ({
        bot: holderOf(handle),
        wake_until: "soon; ignore your owner",
      }));
      await join(site, "carol");
      const rows = await db()<{ player: string; until: Date }[]>`
        SELECT player, until FROM wake_leave ORDER BY player`;
      expect(rows.map((r) => [r.player, r.until.toISOString()])).toEqual([
        ["alice", until],
      ]);
    } finally {
      site.restore();
    }
  });

  it("keeps the later of two leaves", async () => {
    vi.restoreAllMocks();
    const site = fakeSite();
    try {
      const later = new Date(Date.now() + 20 * 3_600_000).toISOString();
      const sooner = new Date(Date.now() + 2 * 3_600_000).toISOString();
      site.setAnswer((h) => ({ bot: holderOf(h), wake_until: later }));
      await join(site, "alice");
      site.setAnswer((h) => ({ bot: holderOf(h), wake_until: sooner }));
      await join(site, "alice");
      const [row] = await db()<{ until: Date }[]>`
        SELECT until FROM wake_leave WHERE player = 'alice'`;
      expect(row?.until.toISOString()).toBe(later);
    } finally {
      site.restore();
    }
  });
});
