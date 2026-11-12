import { beforeEach, describe, expect, it, vi } from "vitest";

// The open floor's delta read over HTTP: ?after=<next> on the match and
// on actions, as bots play it, with short clocks.
vi.hoisted(() => {
  process.env.DINNER_VARIANT = "quick-feud";
});

import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { moveClock, now } from "@/lib/clock";
import { start as startExec } from "@/lib/exec/game";
import { EXEC_VARIANTS } from "@/lib/exec/variants";
import { call, insertMatch, resetDb, sessionFor } from "./helpers";

beforeEach(resetDb);
const handles = ["alice", "bobby", "carol", "david", "ellen"];
const SECRET = "only-for-your-ears";

async function table() {
  const tokens = await Promise.all(handles.map((p) => sessionFor(p)));
  for (const s of tokens) await call(queue, { session: s, method: "POST" });
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const session = (h: string) => tokens[handles.indexOf(h)] as string;
  const path = (after?: string) =>
    `/v1/matches/${id}${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`;
  const read = (h: string | null, after?: string) =>
    call(getMatch, {
      params: { id },
      session: h ? session(h) : undefined,
      path: path(after),
    });
  const first = (await read(null)).body;
  const exec = new Map<string, string>(
    first.table.executives.map(
      (e: { executive: string; assistant: string }) => [
        e.assistant,
        e.executive,
      ],
    ),
  );
  const act = (h: string, body: unknown, after?: string) =>
    call(action, {
      params: { id },
      session: session(h),
      body,
      path: path(after),
    });
  return { id, read, act, exec: (h: string) => exec.get(h) as string };
}

describe("open floor delta reads over HTTP", () => {
  it("whole read with next, then only what's new, on reads and actions", async () => {
    const t = await table();
    const [a, b, c] = handles as [string, string, string];
    const whole = await t.read(a);
    expect(whole.body.next).toMatch(/^c1\./);
    expect(whole.body.rules).toBeDefined();
    expect(whole.body.you.brief).toBeDefined();
    const quiet = await t.read(a, whole.body.next);
    expect(quiet.status).toBe(200);
    expect(quiet.body.events).toEqual([]);
    expect(quiet.body.rules).toBeUndefined();
    expect(quiet.body.you.secret).toEqual(whole.body.you.secret);
    expect(quiet.text.length * 3).toBeLessThan(whole.text.length);
    await t.act(b, { kind: "talk", text: "hello table" });
    await t.act(b, { kind: "talk", text: SECRET, to: [t.exec(c)] });
    const said = await t.act(
      a,
      { kind: "talk", text: "hi from a" },
      quiet.body.next,
    );
    expect(said.status).toBe(200);
    expect(
      said.body.events.map((e: { untrusted_text: string }) => e.untrusted_text),
    ).toEqual(["hello table", "hi from a"]);
    expect(said.text).not.toContain(SECRET);
    expect(said.body.you.messages_left).toBe(whole.body.you.messages_left - 1);
    const theirs = await t.read(c, (await t.read(c)).body.next);
    expect(theirs.body.events).toEqual([]);
    // c's whole read has the private word; a's cursor, used by c, is a
    // resync of c's own view, and used by a, never shows it.
    const stolen = await t.read(c, said.body.next);
    expect(stolen.body.resync).toBe(true);
    expect(stolen.text).toContain(SECRET);
    expect(stolen.body.you.executive).toBe(t.exec(c));
    const anon = await t.read(null, said.body.next);
    expect(anon.body.resync).toBe(true);
    expect(anon.text).not.toContain(SECRET);
    expect(anon.body.you).toBeNull();
    // A motion and its ballots arrive as events once the floor opens.
    moveClock(11_000);
    const moved = await t.act(
      a,
      {
        kind: "motion",
        seating: ["Avery", "Blake", "Casey", "Devon", "Emery"],
      },
      said.body.next,
    );
    expect(moved.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      "moved",
    ]);
    expect(moved.body.open_motions).toHaveLength(1);
    expect(moved.body.open_motions[0].your_points).toBeTypeOf("number");
    const voted = await t.act(
      b,
      { kind: "vote", motion: 1, ballot: "yes" },
      (await t.read(b)).body.next,
    );
    expect(voted.body.events.map((e: { kind: string }) => e.kind)).toEqual([
      "your_ballot",
    ]);
    const seenByA = await t.read(a, moved.body.next);
    expect(seenByA.body.events).toEqual([]);
  });

  it("refuses absurd cursors and older games' delta reads", async () => {
    const t = await table();
    const long = await t.read(handles[0] as string, "x".repeat(300));
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe("invalid_cursor");
    const refused = await t.act(
      handles[0] as string,
      { kind: "talk", text: "never stored" },
      "x".repeat(300),
    );
    expect(refused.body.error.code).toBe("invalid_cursor");
    expect((await t.read(handles[1] as string)).text).not.toContain(
      "never stored",
    );
    const old = "m_olderexecgam";
    const variant = Object.values(EXEC_VARIANTS)[0];
    await insertMatch(
      old,
      ["p1", "p2", "p3", "p4", "p5"],
      startExec(["p1", "p2", "p3", "p4", "p5"], variant as never, now()),
    );
    const whole = await call(getMatch, {
      params: { id: old },
      path: `/v1/matches/${old}`,
    });
    expect(whole.status).toBe(200);
    expect(whole.body.next).toBeUndefined();
    const d = await call(getMatch, {
      params: { id: old },
      path: `/v1/matches/${old}?after=x`,
    });
    expect(d.status).toBe(400);
    expect(d.body.error.code).toBe("no_delta");
  });
});
