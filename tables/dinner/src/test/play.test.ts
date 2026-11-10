import { db } from "@unprompted-tables/server";
import { feedSchema, listSchema } from "@unprompted-tables/spectator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as skill } from "@/app/skill.md/route";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { GET as describeTable } from "@/app/v1/route";
import { GET as spectateOne } from "@/app/v1/spectate/[id]/route";
import { GET as spectateList } from "@/app/v1/spectate/route";
import { moveClock } from "@/lib/clock";
import { VARIANTS } from "@/lib/variants";
import {
  call,
  countRows,
  fakeSite,
  join,
  resetDb,
  sessionFor,
} from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});
const handles = ["alice", "bobby", "carol", "david", "ellen", "frank"];
const talkSeconds = VARIANTS.quick?.talk_seconds as number;

async function party() {
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  await Promise.all(
    tokens.map((s) => call(queue, { session: s, method: "POST" })),
  );
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const guests = (await call(getMatch, { params: { id } })).body.guests as {
    guest: string;
    player: string;
  }[];
  const seat = (handle: string) => tokens[handles.indexOf(handle)] as string;
  const act = (handle: string, body: unknown) =>
    call(action, { params: { id }, session: seat(handle), body });
  return { id, tokens, guests, names: guests.map((g) => g.guest), act, seat };
}

describe("dinner party over HTTP", () => {
  it("trades a pass for a session and seats six into one party", async () => {
    const site = fakeSite();
    try {
      const p = await join(site, "alice");
      expect(p.session).toMatch(/^dinner_/);
    } finally {
      site.restore();
    }
    const g = await party();
    expect(g.id).toMatch(/^m_/);
    expect(g.guests.map((x) => x.player)).toEqual(
      expect.arrayContaining(handles),
    );
    const rows = await db()`SELECT players FROM matches`;
    expect(rows).toHaveLength(1);
  });

  it("shows each guest only their own brief, and outsiders none", async () => {
    const g = await party();
    const mine = await call(getMatch, {
      params: { id: g.id },
      session: g.seat("alice"),
    });
    expect(mine.headers.get("cache-control")).toBe("no-store");
    expect(mine.body.you.brief).toContain("You are");
    const theirs = await call(getMatch, {
      params: { id: g.id },
      session: g.seat("bobby"),
    });
    // JSON writes a brief's newlines as \n, so compare the JSON forms.
    const json = (text: string) => JSON.stringify(text).slice(1, -1);
    expect(JSON.stringify(mine.body)).toContain(json(mine.body.you.brief));
    expect(JSON.stringify(theirs.body)).not.toContain(
      json(mine.body.you.brief),
    );
    expect(JSON.stringify(mine.body)).not.toContain(
      json(theirs.body.you.brief),
    );
    const outsider = await call(getMatch, { params: { id: g.id } });
    expect(outsider.body.you).toBeNull();
    expect(JSON.stringify(outsider.body)).not.toContain(
      json(mine.body.you.brief),
    );
    expect(JSON.stringify(outsider.body)).not.toContain("feelings");
    expect(JSON.stringify(outsider.body)).not.toContain("seed");
  });

  it("plays to consensus and reveals everything at the end", async () => {
    const g = await party();
    const first = await g.act("alice", {
      kind: "talk",
      text: "<script>alert(1)</script> seat me by the window",
    });
    expect(first.status).toBe(200);
    expect(first.body.talk[0].untrusted_text).toContain("<script>");
    expect(
      (await g.act("alice", { kind: "propose", seating: g.names })).status,
    ).toBe(200);
    for (const h of handles.slice(1))
      expect((await g.act(h, { kind: "back", proposal: "P1" })).status).toBe(
        200,
      );
    const done = await call(getMatch, { params: { id: g.id } });
    expect(done.body.phase).toBe("over");
    expect(done.body.result.how).toBe("consensus");
    expect(done.body.result.guests).toHaveLength(6);
    expect(done.body.result.guests[0].brief).toContain("You are");
    expect(await countRows("results")).toBe(1);
    expect(await countRows("open_matches")).toBe(0);
    const late = await g.act("bobby", { kind: "talk", text: "hello?" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("match_over");
  });

  it("refuses strangers, bad bodies and other people's seats", async () => {
    const g = await party();
    const outsider = await sessionFor("mallory");
    const r = await call(action, {
      params: { id: g.id },
      session: outsider,
      body: { kind: "talk", text: "let me in" },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("not_seated");
    expect(
      (
        await call(action, {
          params: { id: g.id },
          body: { kind: "talk", text: "x" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await g.act("alice", { kind: "talk", text: "x", player: "bobby" }))
        .status,
    ).toBe(400);
    expect(
      (await g.act("alice", { kind: "back", proposal: "drop table" })).status,
    ).toBe(400);
    expect(
      (await g.act("alice", { kind: "vote", target: "bobby" })).status,
    ).toBe(400);
    expect((await call(getMatch, { params: { id: "m_nope" } })).status).toBe(
      404,
    );
  });

  it("locks by the fallback at the deadline, even if nobody looks until later", async () => {
    const g = await party();
    await g.act("alice", { kind: "propose", seating: g.names });
    await g.act("bobby", { kind: "back", proposal: "P1" });
    moveClock((talkSeconds + 600) * 1000);
    const r = await call(getMatch, { params: { id: g.id } });
    expect(r.body.phase).toBe("over");
    expect(r.body.result.how).toBe("most_backed");
    const [row] = await db()<{ at: Date }[]>`SELECT at FROM results`;
    const [start] = await db()<{ at: string }[]>`
      SELECT body->'body'->>'at' AS at FROM events WHERE kind = 'start'`;
    expect(row?.at.getTime()).toBe(
      Date.parse(start?.at as string) + talkSeconds * 1000,
    );
  });

  it("keeps events append-only", async () => {
    const g = await party();
    await expect(
      db()`UPDATE events SET kind = 'talk' WHERE match_id = ${g.id}`,
    ).rejects.toThrow();
    await expect(
      db()`DELETE FROM events WHERE match_id = ${g.id}`,
    ).rejects.toThrow();
  });

  it("refuses writes when read-only and still shows the party", async () => {
    const g = await party();
    process.env.TABLE_READ_ONLY = "1";
    expect((await g.act("alice", { kind: "talk", text: "hi" })).status).toBe(
      503,
    );
    moveClock((talkSeconds + 1) * 1000);
    const r = await call(getMatch, { params: { id: g.id } });
    expect(r.body.phase).toBe("over");
    expect(await countRows("results")).toBe(0);
  });

  it("describes itself and its guide", async () => {
    const d = await call(describeTable);
    expect(d.body.game).toBe("dinner-party");
    expect(d.body.variant.name).toBe("quick");
    const s = await call(skill);
    expect(s.text).toContain("@dinner-table");
    expect(s.text).toContain("dinner_");
  });
});

describe("the spectator feed", () => {
  it("is valid while live, and carries no brief or feeling", async () => {
    const g = await party();
    const hidden = await g.act("alice", {
      kind: "talk",
      text: "Hello \u202eall, I'm Ada\u200b.",
    });
    expect(hidden.status).toBe(400);
    expect(hidden.body.error.code).toBe("invalid_text");
    await g.act("alice", { kind: "talk", text: "Hello all, I'm Ada." });
    await g.act("bobby", { kind: "propose", seating: g.names });
    const briefs = await Promise.all(
      handles.map(
        async (h) =>
          (await call(getMatch, { params: { id: g.id }, session: g.seat(h) }))
            .body.you.brief as string,
      ),
    );
    const f = await call(spectateOne, { params: { id: g.id } });
    expect(f.status).toBe(200);
    const feed = feedSchema.parse(f.body);
    expect(feed.match.status).toBe("live");
    expect(feed.outcome).toBeNull();
    expect(feed.participants).toHaveLength(6);
    const text = JSON.stringify(f.body);
    for (const b of briefs) {
      for (const line of b.split("\n").slice(1, -1))
        expect(text).not.toContain(line);
    }
    expect(text).not.toContain("feelings");
    expect(text).not.toContain("\u202e");
    expect(feed.timeline.some((e) => e.kind === "talk")).toBe(true);
    expect((f.body.board as { title: string }).title).toContain("P1");
  });

  it("reveals briefs and scores once the party is over", async () => {
    const g = await party();
    await g.act("alice", { kind: "propose", seating: g.names });
    for (const h of handles.slice(1))
      await g.act(h, { kind: "back", proposal: "P1" });
    const feed = feedSchema.parse(
      (await call(spectateOne, { params: { id: g.id } })).body,
    );
    expect(feed.match.status).toBe("over");
    expect(feed.outcome?.reveals).toHaveLength(6);
    expect(feed.outcome?.scores?.rows).toHaveLength(6);
    expect(feed.outcome?.measures.map((m) => m.label)).toContain(
      "Lowest score",
    );
    expect(feed.timeline.at(-1)?.text).toContain("Everyone backed P1");
  });

  it("lists recent parties, live first", async () => {
    const g = await party();
    const list = listSchema.parse((await call(spectateList)).body);
    expect(list.matches[0]?.id).toBe(g.id);
    expect(list.matches[0]?.status).toBe("live");
    expect((await call(spectateOne, { params: { id: "m_nope" } })).status).toBe(
      404,
    );
  });
});
