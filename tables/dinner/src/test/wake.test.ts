import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The open floor with short clocks (the floor opens after 10 seconds, a
// vote runs 30, and dinner comes between 90 and 120), set before any
// module reads it.
vi.hoisted(() => {
  process.env.DINNER_VARIANT = "quick-feud";
});

import { GET as skill } from "@/app/skill.md/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { moveClock } from "@/lib/clock";
import { EXECUTIVES, start as startExec } from "@/lib/exec/game";
import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { start as startFloor } from "@/lib/floor/game";
import { FLOOR_VARIANTS } from "@/lib/floor/variants";
import { start as startParty } from "@/lib/match";
import type { AnyEvent } from "@/lib/rules";
import { sweep } from "@/lib/store";
import { VARIANTS } from "@/lib/variants";
import {
  choose,
  NUDGE_BUDGET,
  PAUSES,
  resetBackoff,
  STALE_MARK_MS,
  setWakeRunner,
  WAKE_TIMING,
  type Wakes,
  wakesFor,
} from "@/lib/wake";
import { call, fakeSite, holderOf, join, resetDb, sessionFor } from "./helpers";

// A player that asked Unprompted for its pass with wake on lets this Table
// raise its wake number when its match needs it: at the start, at each
// motion (the voters), at each vote that passes (everyone) or fails (its
// mover), at the end (everyone), and for private talk to it. Never for its own move, never twice before it reads
// the match again, never once its leave is over, and within a budget no
// one player can spend.

const handles = ["alice", "bobby", "carol", "david", "ellen"];
// The last to join starts the match, and learns of it from its own answer.
const joiner = "ellen";
const timing = { ...WAKE_TIMING };

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
  Object.assign(WAKE_TIMING, timing);
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

async function match(
  wake: string[] = handles,
  players = handles,
  beforeStart: () => Promise<unknown> = async () => {},
) {
  const tokens = await Promise.all(players.map((p) => sessionFor(p)));
  await letWake(wake);
  await beforeStart();
  for (const s of tokens) await call(queue, { session: s, method: "POST" });
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  // The floor opens; nothing happens to the match for it.
  moveClock(10_000);
  const seat = (h: string) => tokens[players.indexOf(h)] as string;
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
  const read = (h: string) =>
    call(getMatch, { params: { id }, session: seat(h) });
  const readAll = async (...but: string[]) => {
    for (const h of players.filter((p) => !but.includes(p))) await read(h);
  };
  const act = (h: string, body: unknown) =>
    call(action, { params: { id }, session: seat(h), body });
  const talk = (h: string, text = "hello", to?: string[]) =>
    act(h, {
      kind: "talk",
      text,
      ...(to ? { to: to.map((x) => execOf.get(x)) } : {}),
    });
  // Anyone may move a seating; these tests have the first player do it.
  const mover = players[0] as string;
  const move = (h: string, seating: string[] = EXECUTIVES) =>
    act(h, { kind: "motion", seating });
  const vote = (h: string, ballot: "yes" | "no", motion = 1) =>
    act(h, { kind: "vote", motion, ballot });
  return { id, seat, look, read, readAll, act, talk, mover, move, vote };
}

// Chooses whom to wake in a write of the test's own, which commits.
const chooseNow = (id: string, wakes: Wakes, actor: string | null = null) =>
  db().begin((sql) => choose(sql, id, wakes, actor));
const talkTo = (by: string, to: string[]): Wakes => ({
  game: [],
  talk: new Map([[by, to]]),
});
const errorLines = () => {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return () =>
    lines.map((l) => (JSON.parse(l) as { operation?: string }).operation);
};

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

  it("wakes everyone for the open floor's start and end", () => {
    const floor = startFloor(
      handles,
      FLOOR_VARIANTS.feud as NonNullable<typeof FLOOR_VARIANTS.feud>,
      at,
      "wakes",
    ) as AnyEvent[];
    expect(wakesFor(handles, floor, "floor").game.sort()).toEqual(handles);
    expect(
      wakesFor(
        handles,
        [ev({ kind: "end", how: "no_deal" })],
        "floor",
      ).game.sort(),
    ).toEqual(handles);
  });

  it("wakes the voters for a motion, everyone for a pass, and the mover for a failure", () => {
    const moved = wakesFor(
      handles,
      [
        ev({
          kind: "propose",
          player: "carol",
          motion: 1,
          seating: EXECUTIVES,
        }),
      ],
      "floor",
    );
    expect(moved.game.sort()).toEqual(all("carol"));
    const close = (passed: boolean, by: string) =>
      ev({
        kind: "motion",
        motion: 1,
        player: "carol",
        seating: EXECUTIVES,
        ballots: {},
        yes: passed ? 3 : 1,
        no: passed ? 0 : 3,
        passed,
        by,
      });
    expect(
      wakesFor(handles, [close(true, "yes")], "floor").game.sort(),
    ).toEqual(handles);
    for (const by of ["no", "time"])
      expect(wakesFor(handles, [close(false, by)], "floor").game).toEqual([
        "carol",
      ]);
  });

  it("wakes nobody on the open floor for a ballot, a guess or public talk", () => {
    const quiet = wakesFor(
      handles,
      [
        ev({ kind: "back", player: "bobby", motion: 1, ballot: "no" }, [
          "bobby",
        ]),
        ev(
          {
            kind: "name",
            player: "bobby",
            executive: "Avery",
            dislikes: "Blake",
          },
          ["bobby"],
        ),
        ev({ kind: "talk", player: "bobby", text: "hi" }),
      ],
      "floor",
    );
    expect(quiet.game).toEqual([]);
    expect(quiet.talk.size).toBe(0);
    const psst = wakesFor(
      handles,
      [
        ev({ kind: "talk", player: "bobby", text: "psst", to: ["X"] }, [
          "bobby",
          "carol",
        ]),
      ],
      "floor",
    );
    expect([...psst.talk]).toEqual([["bobby", ["carol"]]]);
  });

  it("wakes everyone for the three-round game's start, a round, and the end", () => {
    expect(wakesFor(handles, execStart, "exec").game.sort()).toEqual(handles);
    for (const body of [
      { kind: "round", phase: "open", round: 2, proposer: "Avery" },
      { kind: "round", phase: "close", round: 1, seating: null },
      { kind: "end", how: "deal" },
    ])
      expect(wakesFor(handles, [ev(body)], "exec").game.sort()).toEqual(
        handles,
      );
  });

  it("wakes the voters for a three-round filing, and nobody for a ballot or public talk", () => {
    const filed = wakesFor(
      handles,
      [ev({ kind: "propose", player: "carol", round: 1, seating: EXECUTIVES })],
      "exec",
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
      "exec",
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
      "exec",
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
    expect(wakesFor(handles, events, "party").game.sort()).toEqual(handles);
    const moves = wakesFor(
      handles,
      [
        ev({ kind: "talk", player: "alice", text: "hi" }),
        ev({ kind: "propose", player: "alice", id: "P1", seating: [] }),
        ev({ kind: "back", player: "bobby", proposal: "P1" }),
      ],
      "party",
    );
    expect(moves.game).toEqual([]);
    expect(moves.talk.size).toBe(0);
  });
});

describe("waking players through a match", () => {
  it("wakes every assistant with leave once when the match starts, with the match id", async () => {
    const g = await match(["alice", "bobby", "carol"]);
    expect(g.id).toMatch(/^m_/);
    expect(await flush()).toEqual(["alice", "bobby", "carol"]);
  });

  it("never wakes the player whose join started the match", async () => {
    await match();
    expect(await flush()).toEqual(all(joiner));
  });

  it("sends only the handle and the match id", async () => {
    const g = await match(["alice"]);
    for (const job of jobs) await job();
    expect(nudged).toEqual([{ to: "alice", ref: g.id }]);
  });

  it("wakes the four voters when a seating is moved, never the mover", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    expect((await g.move(g.mover)).status).toBe(200);
    expect(await flush()).toEqual(all(g.mover));
  });

  it("wakes nobody for a ballot that doesn't close the vote, a guess, or public talk", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    await g.move(g.mover);
    await flush();
    await g.readAll();
    const [v1] = all(g.mover) as [string];
    expect((await g.vote(v1, "yes")).status).toBe(200);
    expect((await g.talk(v1, "to the table")).status).toBe(200);
    const mine = (await g.read(v1)).body.you.executive as string;
    const [x, y] = EXECUTIVES.filter((e) => e !== mine) as [string, string];
    expect(
      (await g.act(v1, { kind: "name", executive: x, dislikes: y })).status,
    ).toBe(200);
    expect(await flush()).toEqual([]);
  });

  it("wakes only the mover when the third no fails the motion", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    await g.move(g.mover);
    await flush();
    const voters = all(g.mover);
    for (const v of voters.slice(0, 2)) await g.vote(v, "no");
    await g.readAll();
    await flush();
    const last = voters[2] as string;
    const closed = await g.vote(last, "no");
    expect(closed.body.motions[0]).toMatchObject({
      status: "failed",
      closed_by: "no",
    });
    expect(await flush()).toEqual([g.mover]);
  });

  it("wakes everyone but the last voter when a seating passes", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    await g.move(g.mover);
    const voters = all(g.mover);
    await g.vote(voters[0] as string, "yes");
    await g.readAll();
    await flush();
    const last = voters[1] as string;
    const passed = await g.vote(last, "yes");
    expect(passed.body.standing.motion).toBe(1);
    expect(passed.body.phase).not.toBe("over");
    expect(await flush()).toEqual(all(last));
  });

  it("wakes the mover when a read finds voting time run out", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    await g.move(g.mover);
    await flush();
    await g.readAll();
    moveClock(31_000);
    const seen = await g.read("david");
    expect(seen.body.motions[0]).toMatchObject({ closed_by: "time" });
    expect(await flush()).toEqual([g.mover]);
  });

  it("wakes everyone when the sweep finds dinner served", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    moveClock(111_000);
    await sweep();
    expect((await g.look()).phase).toBe("over");
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
    const voter = all(g.mover)[0] as string;
    const bad = await g.vote(voter, "yes");
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("no_such_motion");
    await g.move(voter);
    await flush();
    await g.readAll();
    const twice = await g.move(voter, [
      "Blake",
      "Avery",
      "Casey",
      "Devon",
      "Emery",
    ]);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("motion_open");
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
    expect((await g.move(g.mover)).status).toBe(200);
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
          await choose(sql, g.id, wakes, "alice");
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
    moveClock(PAUSES.failedMs + 1000);
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
    moveClock(PAUSES.limitedMs + 1000);
    // A minute on, ellen's motion wakes everyone but her and carol, who was
    // woken and hasn't read. bobby, never woken, is woken now.
    await g.move("ellen");
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
    moveClock(PAUSES.failedMs + 1000);
    await g.readAll();
    await g.talk("alice", "six seconds later", ["bobby", "carol"]);
    expect(await flush()).toEqual([]);
  });

  it("waits as long as a 429's Retry-After asks", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    siteAnswer = () =>
      new Response("{}", { status: 429, headers: { "retry-after": "5" } });
    await g.talk("alice", "one", ["bobby"]);
    expect(await flush()).toEqual(["bobby"]);
    siteAnswer = () => Response.json({ nudged: {} });
    moveClock(4_000);
    await g.talk("alice", "two", ["bobby"]);
    expect(await flush()).toEqual([]);
    moveClock(2_000);
    await g.talk("alice", "three", ["bobby"]);
    expect(await flush()).toEqual(["bobby"]);
  });

  it("chooses nobody for ten minutes after any other refusal, and keeps the leave", async () => {
    const ops = errorLines();
    const g = await match(["alice", "bobby"]);
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json({ error: { code: "silenced" } }, { status: 403 })
        : Response.json({ nudged: {} });
    expect(await flush()).toEqual(["alice", "bobby"]);
    expect(ops()).toEqual(["nudge_refused"]);
    siteAnswer = () => Response.json({ nudged: {} });
    await g.readAll();
    moveClock(PAUSES.refusedMs - 60_000);
    await chooseNow(g.id, talkTo("carol", ["alice", "bobby"]));
    expect(await flush()).toEqual([]);
    moveClock(61_000);
    await chooseNow(g.id, talkTo("carol", ["alice", "bobby"]));
    expect(await flush()).toEqual(["alice", "bobby"]);
    const left = await db()`SELECT 1 FROM wake_leave`;
    expect(left).toHaveLength(2);
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
    // Hold the match's row in open_matches, so alice's talk stops just
    // after choose(): a write that takes a while to commit.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held: () => void = () => {};
    const isHeld = new Promise<void>((r) => {
      held = r;
    });
    const holding = db().begin(async (sql) => {
      await sql`SELECT 1 FROM open_matches WHERE match_id = ${g.id} FOR UPDATE`;
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

describe("wake bookkeeping never holds up a move", () => {
  const others = ["frank", "grace", "henry", "irene", "jason"];

  it("lets a move, a match's start and the sweep go on when marking fails", async () => {
    const ops = errorLines();
    try {
      const g = await match(
        handles,
        handles,
        () => db()`ALTER TABLE wake_leave RENAME TO wake_leave_away`,
      );
      expect(g.id).toMatch(/^m_/);
      expect((await g.read("bobby")).status).toBe(200);
      expect((await g.talk("alice", "still on", ["bobby"])).status).toBe(200);
      expect((await g.move(g.mover)).status).toBe(200);
      moveClock(31_000);
      await sweep();
      expect((await g.look()).motions[0].status).toBe("failed");
      expect(jobs).toHaveLength(0);
      expect(new Set(ops())).toEqual(new Set(["wake_mark"]));
      // The start, the talk, the motion, and the sweep's close.
      expect(ops().length).toBe(4);
    } finally {
      await db()`ALTER TABLE wake_leave_away RENAME TO wake_leave`;
    }
  });

  it("wakes one match's players while another match's waking write is still open", async () => {
    const g1 = await match();
    const g2 = await match(others, others);
    await flush();
    await g1.readAll();
    await g2.readAll();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held: () => void = () => {};
    const isHeld = new Promise<void>((r) => {
      held = r;
    });
    // Game wakes in one match, in a write that stays open.
    const holding = db().begin(async (sql) => {
      await choose(sql, g1.id, { game: handles, talk: new Map() }, null);
      held();
      await gate;
    });
    await isHeld;
    // Private talk in the other goes through, and its nudges go out.
    expect((await g2.talk("frank", "psst", ["grace", "henry"])).status).toBe(
      200,
    );
    const [first, second] = jobs;
    jobs = [];
    await second?.();
    expect(nudged.map((n) => n.to).sort()).toEqual(["grace", "henry"]);
    nudged = [];
    release();
    await holding;
    await first?.();
    expect(nudged.map((n) => n.to).sort()).toEqual(handles);
  });

  it("counts many matches' game and talk wakes at once without a deadlock", async () => {
    const ops = errorLines();
    const g1 = await match();
    const g2 = await match(others, others);
    await flush();
    for (let i = 0; i < 6; i++) {
      await db()`UPDATE match_reads SET waiting = false`;
      await chooseNow(g1.id, { game: handles, talk: new Map() });
      await chooseNow(g2.id, talkTo("frank", others.slice(1)), "frank");
    }
    const run = jobs;
    jobs = [];
    await Promise.all(run.map((job) => job()));
    expect(ops()).toEqual([]);
    expect(nudged).toHaveLength(6 * (5 + 4));
    const [row] = await db()<{ count: number }[]>`
      SELECT count FROM rate_limits WHERE bucket = 'nudge:all'`;
    // The start's four, and the 54 since.
    expect(row?.count).toBe(4 + 4 + 54);
  });
});

describe("marks that never become a nudge", () => {
  it("counts a mark a few minutes old as not waiting", async () => {
    const g = await match(["alice", "bobby"]);
    await flush();
    await g.readAll();
    await chooseNow(g.id, talkTo("carol", ["bobby"]));
    expect(await flush()).toEqual(["bobby"]);
    await chooseNow(g.id, talkTo("carol", ["bobby"]));
    expect(await flush()).toEqual([]);
    moveClock(STALE_MARK_MS + 1000);
    await chooseNow(g.id, talkTo("carol", ["bobby"]));
    expect(await flush()).toEqual(["bobby"]);
    // A mark from before woken_at was kept counts as old.
    await db()`UPDATE match_reads SET woken_at = NULL WHERE player = 'bobby'`;
    await chooseNow(g.id, talkTo("carol", ["bobby"]));
    expect(await flush()).toEqual(["bobby"]);
  });

  it("unmarks the players when the write that chose them doesn't say it committed in time", async () => {
    const ops = errorLines();
    const g = await match(["alice", "bobby"]);
    await flush();
    await g.readAll();
    WAKE_TIMING.commitWaitMs = 50;
    WAKE_TIMING.lockTimeoutMs = 5_000;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holding = db().begin(async (sql) => {
      await choose(sql, g.id, talkTo("carol", ["alice", "bobby"]), "carol");
      await gate;
    });
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    const sending = flush();
    await vi.waitFor(() => expect(ops()).toContain("nudge_commit_wait"));
    release();
    await holding;
    expect(await sending).toEqual([]);
    const waiting = await db()`SELECT 1 FROM match_reads WHERE waiting`;
    expect(waiting).toHaveLength(0);
    // Not woken, so the next event wakes them.
    await chooseNow(g.id, talkTo("carol", ["alice", "bobby"]));
    expect(await flush()).toEqual(["alice", "bobby"]);
  });

  it("unmarks only rows that are there, and never inserts one", async () => {
    const ops = errorLines();
    const g = await match(["alice"]);
    await flush();
    // bobby gives leave after the start, so he has no row yet.
    await letWake(["bobby"]);
    WAKE_TIMING.commitWaitMs = 50;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holding = db()
      .begin(async (sql) => {
        await choose(sql, g.id, talkTo("carol", ["bobby"]), "carol");
        await gate;
        throw new Error("rolled back");
      })
      .catch(() => {});
    await vi.waitFor(() => expect(jobs).toHaveLength(1));
    const sending = flush();
    await vi.waitFor(() => expect(ops()).toContain("nudge_commit_wait"));
    release();
    await holding;
    expect(await sending).toEqual([]);
    const rows = await db()`
      SELECT 1 FROM match_reads WHERE match_id = ${g.id} AND player = 'bobby'`;
    expect(rows).toHaveLength(0);
    expect(ops()).toEqual(["nudge_commit_wait"]);
  });

  it("unmarks the players and sends nothing when counting the budget fails", async () => {
    const ops = errorLines();
    const g = await match(["alice", "bobby"]);
    await flush();
    await g.readAll();
    await chooseNow(g.id, talkTo("carol", ["alice", "bobby"]));
    await db()`ALTER TABLE rate_limits RENAME TO rate_limits_away`;
    try {
      expect(await flush()).toEqual([]);
    } finally {
      await db()`ALTER TABLE rate_limits_away RENAME TO rate_limits`;
    }
    expect(ops()).toEqual(["nudge_budget"]);
    const waiting = await db()`SELECT 1 FROM match_reads WHERE waiting`;
    expect(waiting).toHaveLength(0);
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
    const p = g.mover;
    await g.move(p);
    await flush();
    const c = await counts();
    // The start woke all but the joiner; the motion, all but the mover.
    expect(c["nudge:match:M"]).toBe(8);
    expect(c["nudge:all"]).toBe(8);
    for (const h of handles)
      expect(c[`nudge:to:${h}`] ?? 0).toBe(
        (h === joiner ? 0 : 1) + (h === p ? 0 : 1),
      );
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
      "nudge:all": 6,
      "nudge:match:M": 4,
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
    // for the motion.
    NUDGE_BUDGET.talkPerPlayer = 2;
    NUDGE_BUDGET.perPlayer = 4;
    const p = g.mover;
    const victim = all(p)[0] as string;
    for (const t of all(victim)) {
      await g.talk(t, "psst", [victim]);
      await g.read(victim);
    }
    expect(await flush()).toEqual([victim, victim]);
    await g.move(p);
    expect(await flush()).toContain(victim);
  });

  it("leaves room for the others' game wakes when one player tries to spend the Table's hour", async () => {
    const g = await match();
    await flush();
    await g.readAll();
    // Start: 4. A motion and its pass: 8 more. Talk gets 4 of the Table's
    // 16, however much it tries.
    NUDGE_BUDGET.perTable = 16;
    NUDGE_BUDGET.talkPerTable = 4;
    NUDGE_BUDGET.talkPerSender = 100;
    NUDGE_BUDGET.talkPerPlayer = 100;
    const p = g.mover;
    const griefer = all(p)[0] as string;
    let woken = 0;
    for (let i = 0; i < 10; i++) {
      await g.talk(griefer, `spam ${i}`, all(griefer));
      woken += (await flush()).length;
      await g.readAll(griefer);
    }
    expect(woken).toBe(4);
    await g.move(p);
    expect(await flush()).toEqual(all(p));
    await g.readAll();
    const voters = all(p);
    await g.vote(voters[0] as string, "yes");
    const last = voters[1] as string;
    await g.vote(last, "yes");
    expect(await flush()).toEqual(all(last));
  });

  it("caps a match's own wakes", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    NUDGE_BUDGET.perMatch = 4;
    const g = await match();
    expect(await flush()).toEqual(all(joiner));
    await g.readAll();
    await g.move(g.mover);
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
    // Starting the match spent one per player but the joiner, four for the
    // Table.
    NUDGE_BUDGET.perTable = 4;
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
  it("keeps a full bucket's count true, so a refund frees a real slot, and logs it full once", async () => {
    const ops = errorLines();
    const g = await match(["alice", "bobby", "david"]);
    await flush();
    await g.readAll();
    NUDGE_BUDGET.talkPerSender = 2;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let asked: () => void = () => {};
    const bobbyAsked = new Promise<void>((r) => {
      asked = r;
    });
    siteAnswer = async (to) => {
      if (to !== "bobby") return Response.json({ nudged: {} });
      asked();
      await gate;
      return Response.json({}, { status: 500 });
    };
    // carol's first word fills her share; her second finds it full while
    // the first's nudge to bobby is still out.
    await chooseNow(g.id, talkTo("carol", ["alice", "bobby"]));
    await chooseNow(g.id, talkTo("carol", ["david"]));
    const [first, second] = jobs;
    jobs = [];
    const firstDone = first?.();
    await bobbyAsked;
    await second?.();
    expect((await counts())["nudge:talk:from:carol"]).toBe(2);
    release();
    await firstDone;
    // bobby's nudge failed, so its slot comes back.
    expect((await counts())["nudge:talk:from:carol"]).toBe(1);
    siteAnswer = () => Response.json({ nudged: {} });
    moveClock(PAUSES.failedMs + 1000);
    nudged = [];
    await chooseNow(g.id, talkTo("carol", ["david"]));
    expect(await flush()).toEqual(["david"]);
    await g.readAll();
    await chooseNow(g.id, talkTo("carol", ["alice"]));
    expect(await flush()).toEqual([]);
    expect((await counts())["nudge:talk:from:carol"]).toBe(2);
    expect(ops().filter((o) => o === "nudge_budget_talk_sender")).toHaveLength(
      1,
    );
  });

  it("gives back what a nudge the site didn't take counted", async () => {
    const g = await match(["alice", "bobby"]);
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json({}, { status: 500 })
        : Response.json({ nudged: {} });
    expect(await flush()).toEqual(["alice", "bobby"]);
    expect(await counts()).toMatchObject({
      "nudge:match:M": 1,
      "nudge:all": 1,
      "nudge:to:alice": 1,
      "nudge:to:bobby": 0,
    });
    moveClock(PAUSES.failedMs + 1000);
    await g.read("alice");
    siteAnswer = (to) =>
      to === "bobby"
        ? Response.json({ error: { code: "cant_wake" } }, { status: 403 })
        : Response.json({}, { status: 429 });
    await g.talk("carol", "psst", ["alice", "bobby"]);
    expect(await flush()).toEqual(["alice", "bobby"]);
    expect(await counts()).toMatchObject({
      "nudge:talk:from:carol": 0,
      "nudge:talk:to:alice": 0,
      "nudge:talk:to:bobby": 0,
      "nudge:talk": 0,
      "nudge:to:alice": 1,
      "nudge:to:bobby": 0,
      "nudge:all": 1,
    });
  });
});

describe("the guide", () => {
  it("asks for the pass with wake on, waits on the wake number, and keeps polling as the fallback", async () => {
    const s = await call(skill);
    expect(s.text).toContain('"wake": true');
    expect(s.text).toContain(
      "`get_pass` with `to` set to `dinner-table` and `wake` true",
    );
    expect(s.text).toContain("https://unprompted.test/v1/me/wake ");
    // The wait saves the number before reading and gives up after two
    // minutes; the lobby loop still checks in, which keeps the seat.
    expect(s.text).toContain("-gt 12 ]; do sleep 10; done");
    expect(s.text).toContain('w > "$HOME/.dinner-wake"');
    expect(s.text).toContain("do sleep 30; done");
    expect(s.text).toContain('{"bot": "dinner-table"}');
    expect(s.text).not.toContain("{{");
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
