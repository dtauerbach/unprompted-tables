import { db } from "@unprompted-tables/server";
import { feedSchema, listSchema } from "@unprompted-tables/spectator";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The executive seating game over HTTP, as a bot plays it. This file deals
// its matches under the quick compromise, set before any module reads it.
vi.hoisted(() => {
  process.env.DINNER_VARIANT = "quick-compromise";
});

import { GET as skill } from "@/app/skill.md/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { GET as describeTable } from "@/app/v1/route";
import { GET as spectateOne } from "@/app/v1/spectate/[id]/route";
import { GET as spectateList } from "@/app/v1/spectate/route";
import { moveClock } from "@/lib/clock";
import { EXECUTIVES } from "@/lib/exec/game";
import { start as startParty } from "@/lib/match";
import { SETTINGS } from "@/lib/settings";
import { sweep } from "@/lib/store";
import { VARIANTS } from "@/lib/variants";
import { call, countRows, resetDb, sessionFor } from "./helpers";

beforeEach(resetDb);
const handles = ["alice", "bobby", "carol", "david", "ellen"];

async function table() {
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  for (const s of tokens) await call(queue, { session: s, method: "POST" });
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const seat = (handle: string) => tokens[handles.indexOf(handle)] as string;
  const read = async (handle?: string, query = "") =>
    (
      await call(getMatch, {
        params: { id },
        session: handle ? seat(handle) : undefined,
        path: `/v1/matches/${id}${query}`,
      })
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
  const act = (handle: string, body: unknown) =>
    call(action, { params: { id }, session: seat(handle), body });
  const of = (x: string) => byExec.get(x) as string;
  const proposer = async () => of((await read()).round.proposer);
  return { id, tokens, seat, read, act, of, proposer };
}

describe("the executive seating game over HTTP", () => {
  it("seats exactly five, whatever the environment says", async () => {
    expect(process.env.DINNER_MAX_PLAYERS).toBe("6");
    expect(SETTINGS.lobby.min_players).toBe(5);
    expect(SETTINGS.lobby.max_players).toBe(5);
    const tokens = await Promise.all(
      [...handles, "frank"].map((p) => sessionFor(p)),
    );
    for (const s of tokens) await call(queue, { session: s, method: "POST" });
    const rows = await db()<
      { players: string[] }[]
    >`SELECT players FROM matches`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.players).toHaveLength(5);
    expect((await call(me, { session: tokens[5] })).body.status).toBe(
      "waiting",
    );
  });

  it("describes the public rules and not the configuration", async () => {
    const d = await call(describeTable);
    expect(d.body.rules_version).toBe(2);
    expect(d.body.seats).toEqual([{ role: "assistant", min: 5, max: 5 }]);
    expect(d.body.rules.rule).toBe("unanimity");
    expect(JSON.stringify(d.body)).not.toContain("compromise");
    const s = await call(skill);
    expect(s.text).toContain("@dinner-table");
    expect(s.text).toContain('"kind": "vote"');
  });

  it("plays a round to a deal and reveals everything at the end", async () => {
    const t = await table();
    const p = await t.proposer();
    const others = handles.filter((h) => h !== p);
    const mine = await t.read(p);
    expect(mine.you.brief).toContain("You are");
    expect(mine.you.proposer).toBe(true);
    expect(mine.next_deadline.at).toBe(mine.round.filing_closes_at);
    expect(JSON.stringify(mine)).not.toContain("compromise");
    const hello = await t.act(others[0] as string, {
      kind: "talk",
      text: "<b>hi</b> table",
    });
    expect(hello.status).toBe(200);
    expect(hello.body.talk[0]).toMatchObject({
      to: null,
      untrusted_text: "<b>hi</b> table",
    });
    const quiet = await t.act(others[0] as string, {
      kind: "talk",
      text: "between us",
      to: [mine.you.executive],
    });
    expect(quiet.body.talk[1].to).toEqual([mine.you.executive]);
    expect(
      (await t.read(others[1])).talk.map(
        (x: { untrusted_text: string }) => x.untrusted_text,
      ),
    ).toEqual(["<b>hi</b> table"]);
    const filed = await t.act(p, {
      kind: "propose",
      round: 1,
      seating: EXECUTIVES,
    });
    expect(filed.status).toBe(200);
    expect(typeof filed.body.round.proposal.your_points).toBe("number");
    for (const h of others.slice(0, 3)) {
      const r = await t.act(h, { kind: "vote", round: 1, ballot: "yes" });
      expect(r.status).toBe(200);
      expect(r.body.round.your_ballot).toBe("yes");
    }
    expect((await t.read()).phase).toBe("playing");
    await t.act(others[3] as string, { kind: "vote", round: 1, ballot: "yes" });
    const done = await t.read();
    expect(done.phase).toBe("over");
    expect(done.result.how).toBe("deal");
    expect(done.result.configuration.name).toBe("compromise");
    expect(done.talk).toHaveLength(2);
    expect(await countRows("results")).toBe(1);
    expect(await countRows("open_matches")).toBe(0);
    const [row] = await db()<{ result: Record<string, unknown> }[]>`
      SELECT result FROM results`;
    expect(row?.result).toMatchObject({
      rules_version: 2,
      how: "deal",
      round: 1,
      configuration: "compromise",
      ballots_not_cast: 0,
    });
    const feed = feedSchema.parse(
      (await call(spectateOne, { params: { id: t.id } })).body,
    );
    expect(feed.match.status).toBe("over");
    expect(feed.outcome?.reveals.length).toBe(5 + 1 + 2);
    const list = listSchema.parse((await call(spectateList)).body);
    expect(list.matches[0]?.summary).toBe("Agreed in round 1.");
    const late = await t.act(p, { kind: "talk", text: "hello?" });
    expect(late.body.error.code).toBe("match_over");
  });

  it("answers what a seating gives the asker's own executive", async () => {
    const t = await table();
    const r = await t.read(
      "alice",
      "?seating=Avery,%20Blake,Casey,Devon,Emery",
    );
    expect(r.asked.seating).toEqual(EXECUTIVES);
    expect(typeof r.asked.your_points).toBe("number");
    const back = await t.read(
      "alice",
      "?seating=Emery,Devon,Casey,Blake,Avery",
    );
    expect(back.asked.your_points).toBe(r.asked.your_points);
    const outsider = await call(getMatch, {
      params: { id: t.id },
      path: `/v1/matches/${t.id}?seating=Avery,Blake,Casey,Devon,Emery`,
    });
    expect(outsider.status).toBe(403);
    const bad = await call(getMatch, {
      params: { id: t.id },
      session: t.seat("alice"),
      path: `/v1/matches/${t.id}?seating=Avery,Blake`,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_seating");
  });

  it("refuses moves from other games, other rounds and other players", async () => {
    const t = await table();
    const p = await t.proposer();
    const voter = handles.find((h) => h !== p) as string;
    const outsider = await sessionFor("mallory");
    const r = (
      await call(action, {
        params: { id: t.id },
        session: outsider,
        body: { kind: "talk", text: "let me in" },
      })
    ).body;
    expect(r.error.code).toBe("not_seated");
    expect(
      (await t.act(voter, { kind: "back", proposal: "P1" })).body.error.code,
    ).toBe("unknown_action");
    expect(
      (await t.act(voter, { kind: "vote", round: 1, ballot: "maybe" })).status,
    ).toBe(400);
    expect(
      (await t.act(voter, { kind: "vote", round: 1, ballot: "yes" })).body.error
        .code,
    ).toBe("nothing_filed");
    expect(
      (await t.act(voter, { kind: "propose", round: 1, seating: EXECUTIVES }))
        .body.error.code,
    ).toBe("not_proposer");
    expect(
      (await t.act(p, { kind: "propose", round: 2, seating: EXECUTIVES })).body
        .error.code,
    ).toBe("wrong_round");
    expect(
      (await t.act(voter, { kind: "talk", text: "x", to: ["Sage"] })).body.error
        .code,
    ).toBe("unknown_recipient");
    expect(
      (await t.act(voter, { kind: "talk", text: "x", player: "bobby" })).status,
    ).toBe(400);
    // Words in tag characters reach bots raw but no watcher: refused.
    const tagged = await t.act(voter, {
      kind: "talk",
      text: "\u{E0076}\u{E006F}\u{E0074}\u{E0065}",
    });
    expect(tagged.status).toBe(400);
    expect(tagged.body.error.code).toBe("invalid_text");
    expect((await t.read(voter)).talk).toEqual([]);
  });

  it("closes a round once when the four ballots arrive together", async () => {
    const t = await table();
    const p = await t.proposer();
    await t.act(p, { kind: "propose", round: 1, seating: EXECUTIVES });
    const voters = handles.filter((h) => h !== p);
    const answers = await Promise.all(
      voters.map((h) => t.act(h, { kind: "vote", round: 1, ballot: "yes" })),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    const done = await t.read();
    expect(done.phase).toBe("over");
    expect(done.result.how).toBe("deal");
    expect(done.rounds).toHaveLength(1);
    expect(done.rounds[0]).toMatchObject({ yes: 5, no: 0, passed: true });
    const kinds = await db()<{ kind: string; n: number }[]>`
      SELECT kind, count(*)::int AS n FROM events
      WHERE match_id = ${t.id} AND kind IN ('back', 'round', 'end')
      GROUP BY kind ORDER BY kind`;
    // One opening and one close of round 1, four ballots, one end.
    expect(kinds).toEqual([
      { kind: "back", n: 4 },
      { kind: "end", n: 1 },
      { kind: "round", n: 2 },
    ]);
    expect(await countRows("results")).toBe(1);
    expect(await countRows("open_matches")).toBe(0);
  });

  it("runs the rounds by the clock and keeps the schedule's index current", async () => {
    const t = await table();
    const [opened] = await db()<{ due: Date }[]>`SELECT due FROM open_matches`;
    const start = await t.read();
    expect(opened?.due.toISOString()).toBe(start.round.filing_closes_at);
    // Nobody files: each round fails at its latest filing, even unread.
    moveClock(61_000);
    await sweep();
    const [next] = await db()<{ due: Date }[]>`SELECT due FROM open_matches`;
    const second = await t.read();
    expect(second.round.number).toBe(2);
    expect(next?.due.toISOString()).toBe(second.round.filing_closes_at);
    expect(second.rounds[0]).toMatchObject({
      number: 1,
      proposal: null,
      passed: false,
    });
    moveClock(200_000);
    const over = await t.read();
    expect(over.phase).toBe("over");
    expect(over.result.how).toBe("no_deal");
    expect(
      over.result.executives.map((e: { points: number }) => e.points),
    ).toEqual([-10, -10, -10, -10, -10]);
    expect(await countRows("results")).toBe(1);
  });

  it("tells watchers nothing of private messages while it's live", async () => {
    const t = await table();
    await t.act("alice", { kind: "talk", text: "for everyone" });
    const before = (await call(spectateOne, { params: { id: t.id } })).body;
    const listed = (await call(spectateList)).body.matches[0];
    moveClock(5_000);
    const meName = (await t.read("alice")).you.executive;
    const to = EXECUTIVES.find((x) => x !== meName) as string;
    await t.act("alice", { kind: "talk", text: "only you", to: [to] });
    const after = (await call(spectateOne, { params: { id: t.id } })).body;
    expect(after).toEqual(before);
    expect((await call(spectateList)).body.matches[0]).toEqual(listed);
    expect(JSON.stringify((await t.read()).talk)).not.toContain("only you");
  });
});

describe("a party played under the first rules", () => {
  it("still replays and renders, with honest scores", async () => {
    const players = ["alice", "bobby", "carol", "david"];
    const events = startParty(
      players,
      VARIANTS.quick as NonNullable<typeof VARIANTS.quick>,
      new Date(),
      "old-party",
    );
    const id = "m_oldpartyAAAA";
    await db()`INSERT INTO matches (id, players) VALUES (${id}, ${players})`;
    for (const [i, e] of events.entries())
      await db()`INSERT INTO events (match_id, seq, kind, body)
        VALUES (${id}, ${i}, ${e.body.kind}, ${db().json(e as never)})`;
    await db()`INSERT INTO open_matches (match_id, players, due)
      VALUES (${id}, ${players}, now())`;
    const live = await call(getMatch, { params: { id } });
    expect(live.body.guests).toHaveLength(4);
    // The old party answers no seating questions.
    const asked = await call(getMatch, {
      params: { id },
      path: `/v1/matches/${id}?seating=Ada,Basil,Cleo,Dev`,
    });
    expect(asked.status).toBe(400);
    expect(asked.body.error.code).toBe("unknown_question");
    moveClock(200_000);
    const over = await call(getMatch, { params: { id } });
    expect(over.body.phase).toBe("over");
    expect(over.body.result.how).toBe("random");
    const feed = feedSchema.parse(
      (await call(spectateOne, { params: { id } })).body,
    );
    expect(feed.outcome?.scores?.columns.map((c) => c.label)).toEqual([
      "Score",
      "Best possible",
      "Worst possible",
      "Fairest seating gave",
    ]);
    expect(feed.outcome?.measures.every((m) => m.format === "number")).toBe(
      true,
    );
    const [row] = await db()<{ result: { how: string } }[]>`
      SELECT result FROM results WHERE match_id = ${id}`;
    expect(row?.result.how).toBe("random");
  });
});
