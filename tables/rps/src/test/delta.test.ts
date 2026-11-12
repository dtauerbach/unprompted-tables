import { spawnSync } from "node:child_process";
import { sealOf } from "@unprompted-tables/game";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as guideRoute } from "@/app/skill.md/route";
import { POST as commitRoute } from "@/app/v1/matches/[id]/commit/route";
import { GET as matchRoute } from "@/app/v1/matches/[id]/route";
import { POST as queueRoute } from "@/app/v1/queue/route";
import { sealFields } from "@/lib/match";
import { call, resetDb, sessionFor } from "./helpers";

// ?after=<next> on GET /v1/matches/<id>: only the events since that read.

beforeEach(resetDb);

const look = (id: string, after?: string) =>
  call(matchRoute, {
    params: { id },
    path: `/v1/matches/${id}${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`,
  });

describe("RPS delta reads", () => {
  it("answers next, then only new events, and resyncs a cursor that isn't one", async () => {
    const a = { handle: "ruby", session: await sessionFor("ruby") };
    const b = { handle: "jade", session: await sessionFor("jade") };
    await call(queueRoute, { session: a.session, body: {} });
    const id = (await call(queueRoute, { session: b.session, body: {} })).body
      .match as string;
    const first = (await look(id)).body.match;
    expect(first.next).toMatch(/^c1\./);
    expect(first.events.length).toBeGreaterThan(0);
    const quiet = (await look(id, first.next)).body.match;
    expect(quiet.events).toEqual([]);
    expect(quiet.phase).toBe("commit");
    const salt = "salt-ruby-1-0000000000";
    await call(commitRoute, {
      session: a.session,
      params: { id },
      body: { round: 1, seal: sealOf(sealFields(id, 1, "ruby", "rock", salt)) },
    });
    const fresh = (await look(id, quiet.next)).body.match;
    expect(fresh.events).toHaveLength(1);
    expect(fresh.events[0].kind).toBe("commit");
    const whole = (await look(id)).body.match.events;
    for (const forged of ["", "3", "c1.AAAA", `${fresh.next}x`]) {
      const r = (await look(id, forged)).body.match;
      expect(r.resync).toBe(true);
      expect(r.events).toEqual(whole);
    }
    const long = await look(id, "c".repeat(201));
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe("invalid_cursor");
  });

  it("waits with &wait=N until an event, or answers nothing on time", async () => {
    const a = { handle: "ruby", session: await sessionFor("ruby") };
    const b = { handle: "jade", session: await sessionFor("jade") };
    await call(queueRoute, { session: a.session, body: {} });
    const id = (await call(queueRoute, { session: b.session, body: {} })).body
      .match as string;
    const next = (await look(id)).body.match.next as string;
    const waiting = (wait: number | string) =>
      call(matchRoute, {
        params: { id },
        path: `/v1/matches/${id}?after=${encodeURIComponent(next)}&wait=${wait}`,
      });
    let t = Date.now();
    const timedOut = (await waiting(2)).body.match;
    expect(timedOut.events).toEqual([]);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
    t = Date.now();
    const held = waiting(10);
    await new Promise((r) => setTimeout(r, 300));
    const salt = "salt-jade-1-0000000000";
    await call(commitRoute, {
      session: b.session,
      params: { id },
      body: {
        round: 1,
        seal: sealOf(sealFields(id, 1, "jade", "paper", salt)),
      },
    });
    const got = (await held).body.match;
    expect(got.events.map((e: { kind: string }) => e.kind)).toEqual(["commit"]);
    expect(Date.now() - t).toBeLessThan(4000);
    const bad = await waiting(30);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_wait");
    // The guide's loop: its grep, run on the very text the Table sends,
    // keeps waiting on a quiet answer and stops on news or an error.
    const guide = await (
      await guideRoute(new Request("https://rps.test/skill.md"))
    ).text();
    const loop =
      guide
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("until ") && l.includes("wait=25")) ?? "";
    expect(loop).toContain(
      "https://rps.test/v1/matches/$MATCH?after=$NEXT&wait=25",
    );
    expect(Number(loop.match(/curl -sS -m (\d+) /)?.[1])).toBeGreaterThan(25);
    const grep = loop.match(/\| (grep [^;]+); do/)?.[1] ?? "";
    const done = (text: string) =>
      spawnSync("bash", ["-c", grep], { input: text }).status === 0;
    const quiet = await call(matchRoute, {
      params: { id },
      path: `/v1/matches/${id}?after=${encodeURIComponent(got.next)}&wait=1`,
    });
    expect(quiet.body.match.events).toEqual([]);
    expect(done(quiet.text)).toBe(false);
    expect(done((await waiting(1)).text)).toBe(true);
    expect(done(bad.text)).toBe(true);
    expect(spawnSync("bash", ["-c", grep], { input: "" }).status).not.toBe(0);
  });
});
