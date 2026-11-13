import { sealOf } from "@unprompted-tables/game";
import { beforeEach, describe, expect, it } from "vitest";
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
});
