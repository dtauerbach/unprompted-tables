import { db } from "@unprompted-tables/server";
import { feedSchema, listSchema } from "@unprompted-tables/spectator";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The open floor over HTTP, as bots play it, with short clocks: the floor
// opens after 10 seconds, a vote runs 30, and dinner comes at a hidden
// moment between 90 and 120 seconds in. Set before any module reads it.
vi.hoisted(() => {
  process.env.DINNER_VARIANT = "quick-feud";
});

import { GET as skill } from "@/app/skill.md/route";
import { GET as lobbyRoute } from "@/app/v1/lobby/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { GET as describeTable } from "@/app/v1/route";
import { GET as spectateOne } from "@/app/v1/spectate/[id]/route";
import { GET as spectateList } from "@/app/v1/spectate/route";
import { moveClock, now } from "@/lib/clock";
import {
  EXECUTIVES,
  type FloorDeal,
  points,
  start as startFloor,
} from "@/lib/floor/game";
import { floorMatch, QUICK, seedWhere } from "@/lib/floor/test-harness";
import { SETTINGS } from "@/lib/settings";
import { sweep } from "@/lib/store";
import { call, countRows, insertMatch, resetDb, sessionFor } from "./helpers";

beforeEach(resetDb);
const handles = ["alice", "bobby", "carol", "david", "ellen"];
const S1 = ["Avery", "Blake", "Casey", "Devon", "Emery"];
const S2 = ["Blake", "Avery", "Casey", "Devon", "Emery"];
const S3 = ["Casey", "Avery", "Blake", "Devon", "Emery"];

// Every answer a test reads, kept so it can check none of them shows what
// stays hidden.
let seen: string[] = [];

async function table(insert?: { id: string; seed: string }) {
  seen = [];
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  if (insert)
    await insertMatch(
      insert.id,
      handles,
      startFloor(handles, QUICK, now(), insert.seed),
    );
  else
    for (const s of tokens) await call(queue, { session: s, method: "POST" });
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const seat = (handle: string) => tokens[handles.indexOf(handle)] as string;
  const keep = <T extends { text: string }>(r: T): T => {
    seen.push(r.text);
    return r;
  };
  const read = async (handle?: string, query = "") =>
    keep(
      await call(getMatch, {
        params: { id },
        session: handle ? seat(handle) : undefined,
        path: `/v1/matches/${id}${query}`,
      }),
    ).body;
  const first = await read();
  const byExec = new Map<string, string>(
    first.table.executives.map(
      (e: { executive: string; assistant: string }) => [
        e.executive,
        e.assistant,
      ],
    ),
  );
  const of = (x: string) => byExec.get(x) as string;
  const act = async (executive: string, body: unknown) =>
    keep(
      await call(action, {
        params: { id },
        session: seat(of(executive)),
        body,
      }),
    );
  const watch = async () => {
    const one = keep(await call(spectateOne, { params: { id } }));
    keep(await call(spectateList));
    keep(await call(describeTable));
    keep(await call(me, { session: tokens[0] }));
    return one.body;
  };
  const events = async () =>
    (
      await db()<{ n: number }[]>`
        SELECT count(*)::int AS n FROM events WHERE match_id = ${id}`
    )[0]?.n;
  const deal = async () =>
    (
      await db()<{ body: { body: { deal: FloorDeal; at: string } } }[]>`
        SELECT body FROM events WHERE match_id = ${id} AND kind = 'deal'`
    )[0]?.body.body as { deal: FloorDeal; at: string };
  return { id, tokens, seat, read, act, of, watch, events, deal };
}

describe("the open floor over HTTP", () => {
  it("seats exactly five, whatever the environment says", async () => {
    expect(process.env.DINNER_MAX_PLAYERS).toBe("6");
    expect(SETTINGS.lobby).toMatchObject({ min_players: 5, max_players: 5 });
    const tokens = await Promise.all(
      [...handles, "frank"].map((p) => sessionFor(p)),
    );
    for (const s of tokens) await call(queue, { session: s, method: "POST" });
    const rows = await db()<
      { players: string[] }[]
    >`SELECT players FROM matches`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.players).toHaveLength(5);
    const spare = await call(me, { session: tokens[5] });
    expect(spare.body.status).toBe("waiting");
    // What the guide tells a spare to check before it leaves: alone in the
    // lobby, with a live match listed.
    const lobby = (await call(lobbyRoute)).body.lobby as { seated: string[] };
    expect(lobby.seated).toEqual([spare.body.player]);
    const list = listSchema.parse((await call(spectateList)).body);
    expect(list.matches.filter((m) => m.status === "live")).toHaveLength(1);
  });

  it("describes the public rules, never the level, and the guide teaches the moves", async () => {
    const d = await call(describeTable);
    expect(d.body.rules_version).toBe(3);
    expect(d.body.seats).toEqual([{ role: "assistant", min: 5, max: 5 }]);
    expect(d.body.rules).toMatchObject({
      yes_needed: 3,
      no_to_fail: 3,
      vote_seconds: 30,
      served_between_seconds: [90, 120],
      motions_per_assistant: 3,
      naming: { right: 0, wrong: 0, exposed: 0 },
    });
    expect(d.text).not.toMatch(/feud|simmer|knives|level/);
    const s = await call(skill);
    for (const move of [
      '"kind": "motion"',
      '"kind": "vote"',
      '"kind": "name"',
      "?seating=",
    ])
      expect(s.text).toContain(move);
    expect(s.text).not.toMatch(/feud|simmer|knives/);
    expect(s.text).not.toContain("{{");
    // Guesses are optional and unscored, and the guide says so.
    expect(s.text).toContain(
      "Guesses score nothing and are shown after dinner.",
    );
    expect(s.text).not.toMatch(/naming points|\+2 to you/);
    expect(d.body.rules.summary).toContain(
      "Guesses score nothing and are shown after dinner.",
    );
  });

  it("plays a match: a pass, an overturn, guesses, and dinner, then reveals it all", async () => {
    const t = await table();
    const deal = await t.deal();
    const d = deal.deal;
    const [A, B, C, D, E] = EXECUTIVES as [
      string,
      string,
      string,
      string,
      string,
    ];
    // Before the floor opens: talk, but no motion.
    const early = await t.act(A, { kind: "motion", seating: S1 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("floor_not_open");
    const mine = await t.read(t.of(A));
    expect(mine.floor.open).toBe(false);
    const secret = Object.keys(mine.you.secret)[0] as string;
    expect(mine.you.weights[secret]).toBeLessThan(0);
    await t.act(A, { kind: "talk", text: "<b>evening</b>, table" });
    const quiet = await t.act(A, {
      kind: "talk",
      text: `between us, I can't stand ${secret}`,
      to: [B],
    });
    expect(quiet.status).toBe(200);
    // Others see only the public word; the stranger too.
    for (const who of [t.of(C), undefined]) {
      const v = await t.read(who);
      expect(
        v.talk.map((x: { untrusted_text: string }) => x.untrusted_text),
      ).toEqual(["<b>evening</b>, table"]);
      expect(JSON.stringify(v)).not.toContain("between us");
    }
    moveClock(10_000);
    // A pass: Avery moves, Blake and Casey say yes.
    const moved = await t.act(A, { kind: "motion", seating: S1 });
    expect(moved.status).toBe(200);
    expect(moved.body.motions[0]).toMatchObject({ id: 1, status: "open" });
    expect(typeof moved.body.motions[0].your_points).toBe("number");
    expect(
      (await t.act(B, { kind: "vote", motion: 1, ballot: "yes" })).status,
    ).toBe(200);
    const sealed = await t.read();
    expect(JSON.stringify(sealed)).not.toContain('"ballots"');
    const passed = await t.act(C, { kind: "vote", motion: 1, ballot: "yes" });
    expect(passed.body.standing).toMatchObject({ motion: 1, seating: S1 });
    expect(passed.body.motions[0]).toMatchObject({
      status: "passed",
      closed_by: "yes",
      ballots: { [B]: "yes", [C]: "yes", [D]: null, [E]: null },
    });
    // An overturn: Devon moves, Emery and Blake (a defector) say yes.
    await t.act(D, { kind: "motion", seating: S2 });
    await t.act(E, { kind: "vote", motion: 2, ballot: "yes" });
    const over = await t.act(B, { kind: "vote", motion: 2, ballot: "yes" });
    expect(over.body.standing).toMatchObject({ motion: 2, seating: S2 });
    expect(
      over.body.standing_history.map((h: { motion: number }) => h.motion),
    ).toEqual([1, 2]);
    // A motion that fails by three noes.
    await t.act(E, { kind: "motion", seating: S3 });
    for (const x of [A, C, D])
      await t.act(x, { kind: "vote", motion: 3, ballot: "no" });
    expect((await t.read()).motions[2]).toMatchObject({
      status: "failed",
      closed_by: "no",
    });
    // Guesses: Blake, told in private, is right; Devon is wrong.
    const wrong = EXECUTIVES.find(
      (x) => x !== A && x !== D && x !== secret,
    ) as string;
    expect(
      (await t.act(B, { kind: "name", executive: A, dislikes: secret })).status,
    ).toBe(200);
    const dg = await t.act(D, { kind: "name", executive: A, dislikes: wrong });
    expect(dg.body.you.guesses).toEqual([{ executive: A, dislikes: wrong }]);
    for (const who of [t.of(C), undefined])
      expect(JSON.stringify(await t.read(who))).not.toContain('"guesses":[{');
    // The live feed: public talk, motions, closed ballots; nothing private.
    const live = feedSchema.parse(await t.watch());
    expect(live.match.status).toBe("live");
    const text = JSON.stringify(live);
    expect(text).toContain("Motion 2 passes");
    expect(text).not.toMatch(/can't stand|guess|served_after|"level"/);

    // Dinner comes.
    moveClock(115_000);
    await sweep();
    const done = await t.read();
    expect(done.phase).toBe("over");
    expect(done.dinner.served_at).toBe(
      new Date(Date.parse(deal.at) + d.served_after * 1000).toISOString(),
    );
    const order = S2.map((x) => EXECUTIVES.indexOf(x));
    const seat = points(d, order);
    // Guesses score nothing: a right one, a wrong one and the executive
    // named rightly all keep their seating points.
    expect(done.result).toMatchObject({ how: "seated", motion: 2 });
    expect(
      done.result.executives.map(
        (x: {
          seating_points: number;
          naming_points: number;
          points: number;
        }) => [x.seating_points, x.naming_points, x.points],
      ),
    ).toEqual(seat.map((v) => [v, 0, v]));
    expect(done.talk).toHaveLength(2);
    expect(await countRows("results")).toBe(1);
    expect(await countRows("open_matches")).toBe(0);
    const [row] = await db()<{ result: Record<string, unknown> }[]>`
      SELECT result FROM results`;
    expect(row?.result).toMatchObject({
      rules_version: 3,
      how: "seated",
      motion: 2,
      variant: "quick-feud",
      level: "feud",
      motions: 3,
      passed: 2,
    });
    const feed = feedSchema.parse(
      (await call(spectateOne, { params: { id: t.id } })).body,
    );
    expect(feed.match.status).toBe("over");
    expect(feed.outcome?.reveals.length).toBe(5 + 1 + 1 + 1);
    expect(JSON.stringify(feed)).toContain(`I can't stand ${secret}`);
    const list = listSchema.parse((await call(spectateList)).body);
    expect(list.matches[0]?.summary).toBe(
      "Dinner came with motion 2's seating standing.",
    );
    const late = await t.act(C, { kind: "talk", text: "hello?" });
    expect(late.body.error.code).toBe("match_over");
    const lateGuess = await t.act(C, {
      kind: "name",
      executive: A,
      dislikes: B,
    });
    expect(lateGuess.body.error.code).toBe("match_over");
  });

  it("answers what a seating gives the asker's own executive, and nothing to anyone else", async () => {
    const t = await table();
    const d = (await t.deal()).deal;
    const asker = t.of("Casey");
    const r = await t.read(asker, "?seating=Avery,%20Blake,Casey,Devon,Emery");
    expect(r.asked).toEqual({
      seating: S1,
      your_points: points(d, [0, 1, 2, 3, 4])[2],
    });
    const outsider = await call(getMatch, {
      params: { id: t.id },
      path: `/v1/matches/${t.id}?seating=Avery,Blake,Casey,Devon,Emery`,
    });
    expect(outsider.status).toBe(403);
    expect(outsider.body.error.code).toBe("not_seated");
    const stranger = await sessionFor("mallory");
    const nosy = await call(getMatch, {
      params: { id: t.id },
      session: stranger,
      path: `/v1/matches/${t.id}?seating=Avery,Blake,Casey,Devon,Emery`,
    });
    expect(nosy.status).toBe(403);
    for (const q of ["?seating=Avery,Blake", "?seating=Sage,A,B,C,D"]) {
      const bad = await call(getMatch, {
        params: { id: t.id },
        session: t.seat(asker),
        path: `/v1/matches/${t.id}${q}`,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("invalid_seating");
    }
  });

  it("refuses malformed moves, moves from other games and strangers, and stores nothing for them", async () => {
    const t = await table();
    moveClock(10_000);
    const before = await t.events();
    const outsider = await sessionFor("mallory");
    const r = await call(action, {
      params: { id: t.id },
      session: outsider,
      body: { kind: "motion", seating: S1 },
    });
    expect(r.body.error.code).toBe("not_seated");
    const bad: [unknown, number, string?][] = [
      [{ kind: "propose", round: 1, seating: S1 }, 400, "unknown_action"],
      [{ kind: "back", proposal: "P1" }, 400, "unknown_action"],
      [{ kind: "vote", ballot: "yes" }, 400, "no_motion"],
      [{ kind: "vote", motion: 1, ballot: "maybe" }, 400],
      [{ kind: "vote", motion: 0, ballot: "yes" }, 400],
      [{ kind: "vote", motion: 1.5, ballot: "yes" }, 400],
      [{ kind: "vote", motion: 9, ballot: "yes" }, 409, "no_such_motion"],
      [{ kind: "motion", seating: S1, round: 1 }, 400],
      [
        {
          kind: "motion",
          seating: ["Avery", "Avery", "Blake", "Casey", "Devon"],
        },
        400,
        "invalid_seating",
      ],
      [
        { kind: "motion", seating: ["Sage", ...S1.slice(1)] },
        400,
        "invalid_seating",
      ],
      [{ kind: "motion", seating: "Avery,Blake" }, 400],
      [
        { kind: "name", executive: "Sage", dislikes: "Avery" },
        400,
        "unknown_executive",
      ],
      [
        { kind: "name", executive: "Blake", dislikes: "Blake" },
        400,
        "invalid_guess",
      ],
      [
        { kind: "name", executive: "Avery", dislikes: "Blake" },
        400,
        "naming_yourself",
      ],
      [{ kind: "name", executive: "Blake" }, 400],
      [{ kind: "talk", text: "x", to: ["Sage"] }, 400, "unknown_recipient"],
      [{ kind: "talk", text: "x", to: ["Avery"] }, 400, "no_self_message"],
      [{ kind: "talk", text: "x", player: "bobby" }, 400],
      // Words in tag characters reach bots raw but no watcher: refused.
      [
        { kind: "talk", text: "\u{E0076}\u{E006F}\u{E0074}\u{E0065}" },
        400,
        "invalid_text",
      ],
      [{ kind: "talk", text: "hi‮there" }, 400, "invalid_text"],
      [{ kind: "talk", text: "x".repeat(601) }, 409, "too_long"],
      [{ kind: "verdict", winner: "Avery" }, 400],
    ];
    for (const [body, status, code] of bad) {
      const res = await t.act("Avery", body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      if (code) expect(res.body.error.code, JSON.stringify(body)).toBe(code);
    }
    expect(await t.events()).toBe(before);
    expect((await t.read(t.of("Blake"))).talk).toEqual([]);
  });

  it("holds each assistant to its motions and messages, and stores nothing past them", async () => {
    const t = await table();
    moveClock(10_000);
    // Three motions each, one open at a time.
    const seatings = [S1, S2, S3];
    for (const [k, s] of seatings.entries()) {
      expect(
        (await t.act("Avery", { kind: "motion", seating: s })).status,
      ).toBe(200);
      if (k < 2) {
        expect(
          (await t.act("Avery", { kind: "motion", seating: seatings[k + 1] }))
            .body.error.code,
        ).toBe("motion_open");
        for (const x of ["Blake", "Casey", "Devon"])
          await t.act(x, { kind: "vote", motion: k + 1, ballot: "no" });
      }
    }
    const before = await t.events();
    const fourth = await t.act("Avery", {
      kind: "motion",
      seating: ["Emery", "Devon", "Avery", "Blake", "Casey"],
    });
    expect(fourth.body.error.code).toBe("motion_limit");
    // A ballot is final; the mover can't vote on its own.
    await t.act("Blake", { kind: "vote", motion: 3, ballot: "no" });
    expect(
      (await t.act("Blake", { kind: "vote", motion: 3, ballot: "yes" })).body
        .error.code,
    ).toBe("already_voted");
    expect(
      (await t.act("Avery", { kind: "vote", motion: 3, ballot: "yes" })).body
        .error.code,
    ).toBe("mover_counts_as_yes");
    // After its close, no more ballots.
    moveClock(31_000);
    expect(
      (await t.act("Casey", { kind: "vote", motion: 3, ballot: "yes" })).body
        .error.code,
    ).toBe("voting_closed");
    // One more event: Blake's ballot. A refused move stores nothing, not
    // even the close the clock made; the next look that writes stores it.
    expect(await t.events()).toBe((before as number) + 1);
    // Forty messages, then none.
    for (let i = 0; i < 40; i++)
      expect(
        (await t.act("Emery", { kind: "talk", text: `word ${i}` })).status,
      ).toBe(200);
    const spent = await t.events();
    expect(
      (await t.act("Emery", { kind: "talk", text: "one more" })).body.error
        .code,
    ).toBe("talk_limit");
    expect(await t.events()).toBe(spent);
  });

  it("closes a vote once when ballots arrive together", async () => {
    const t = await table();
    moveClock(10_000);
    await t.act("Avery", { kind: "motion", seating: S1 });
    const answers = await Promise.all(
      ["Blake", "Casey", "Devon", "Emery"].map((x) =>
        t.act(x, { kind: "vote", motion: 1, ballot: "yes" }),
      ),
    );
    const codes = answers.map((a) =>
      a.status === 200 ? "ok" : a.body.error.code,
    );
    // Two yes votes pass it; the rest find the vote closed.
    expect(codes.filter((c) => c === "ok")).toHaveLength(2);
    expect(codes.filter((c) => c === "voting_closed")).toHaveLength(2);
    const kinds = await db()<{ kind: string; n: number }[]>`
      SELECT kind, count(*)::int AS n FROM events
      WHERE match_id = ${t.id} AND kind IN ('back', 'motion')
      GROUP BY kind ORDER BY kind`;
    expect(kinds).toEqual([
      { kind: "back", n: 2 },
      { kind: "motion", n: 1 },
    ]);
  });

  it("ends with no deal when nothing stands, everyone at worst minus the margin", async () => {
    const t = await table();
    moveClock(125_000);
    const done = await t.read();
    expect(done.result.how).toBe("no_deal");
    const r = done.result.executives as {
      points: number;
      worst: number;
    }[];
    for (const x of r) expect(x.points).toBe(x.worst - 3);
    const list = listSchema.parse((await call(spectateList)).body);
    expect(list.matches[0]?.summary).toBe(
      "Dinner came with nothing standing: no deal.",
    );
  });
});

describe("when dinner comes", () => {
  // A deal whose dinner comes 105 seconds in, inside the window.
  const seed = seedWhere((g) => g.served() === 105, QUICK);

  it("shows no reader, watcher or schedule the moment before it comes", async () => {
    const t = await table({ id: "m_hiddenendAAA", seed });
    const { deal, at } = await t.deal();
    expect(deal.served_after).toBe(105);
    const hidden = new Date(Date.parse(at) + 105_000).toISOString();
    const [due] = await db()<{ due: Date }[]>`SELECT due FROM open_matches`;
    // The schedule knows, so the sweep can end it on time...
    expect(due?.due.toISOString()).toBe(hidden);
    // ...but nothing anyone reads says it.
    moveClock(10_000);
    await t.act("Avery", { kind: "motion", seating: S1 });
    await t.act("Blake", { kind: "vote", motion: 1, ballot: "yes" });
    await t.act("Casey", { kind: "talk", text: "and when do we eat?" });
    const check = async () => {
      for (const h of [...handles, undefined]) await t.read(h);
      await t.read("alice", "?seating=Avery,Blake,Casey,Devon,Emery");
      await t.watch();
      const v = await t.read();
      // The public due is only a vote's close, or nothing.
      expect([
        null,
        ...v.motions.map((m: { closes_at: string }) => m.closes_at),
      ]).toContain(v.due);
      expect(v.next_deadline.at).not.toBe(hidden);
    };
    await check();
    // Into the window, a second before. The first look stores what the
    // clock did since (motion 1's vote ran out); after that, looks change
    // nothing, so they take no lock and store nothing, exactly as they
    // would with dinner an hour off.
    moveClock(Date.parse(hidden) - 1_000 - now().getTime());
    expect(now().getTime()).toBeLessThan(Date.parse(hidden));
    expect(now().getTime()).toBeGreaterThan(Date.parse(hidden) - 15_000);
    await sweep();
    await t.read();
    const stored = await t.events();
    await check();
    await sweep();
    expect(await t.events()).toBe(stored);
    expect((await t.read()).phase).toBe("playing");
    for (const text of seen) {
      expect(text).not.toContain(hidden);
      expect(text).not.toContain(hidden.slice(11, 19));
      expect(text).not.toMatch(/served_after|"level"|feud/);
    }
    // Then it comes, for everyone at once.
    moveClock(Date.parse(hidden) - now().getTime());
    const done = await t.read();
    expect(done.phase).toBe("over");
    expect(done.dinner.served_at).toBe(hidden);
    expect(done.result.void).toEqual([]);
  });

  it("voids a vote still open when dinner comes", async () => {
    const g = floorMatch(QUICK, seed);
    const t = await table({ id: "m_voidedvoteAA", seed });
    const { at } = await t.deal();
    const hidden = Date.parse(at) + g.served() * 1000;
    moveClock(hidden - 5_000 - now().getTime());
    await t.act("Avery", { kind: "motion", seating: S1 });
    await t.act("Blake", { kind: "vote", motion: 1, ballot: "yes" });
    moveClock(5_000);
    const done = await t.read();
    expect(done.result).toMatchObject({ how: "no_deal", void: [1] });
    expect(done.motions[0]).toMatchObject({
      status: "void",
      ballots: { Blake: "yes" },
    });
  });
});
