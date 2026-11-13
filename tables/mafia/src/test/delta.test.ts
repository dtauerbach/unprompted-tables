import { beforeEach, describe, expect, it } from "vitest";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as queue } from "@/app/v1/queue/route";
import { call, resetDb, sessionFor } from "./helpers";

// The delta read over HTTP: ?after=<next> on GET /v1/matches/<id> and on
// actions. Night talk and roles stay with their seats, through the reads
// and through the cursors.

beforeEach(resetDb);
const handles = ["alice", "bobby", "carol", "david", "ellen", "frank", "grace"];
type Seat = { handle: string; session: string; side: string };
async function match(names = handles) {
  const tokens = await Promise.all(names.map((p) => sessionFor(p)));
  await Promise.all(
    tokens.map((s) => call(queue, { session: s, method: "POST" })),
  );
  const id = (await call(me, { session: tokens[0] })).body.match as string;
  const seats: Seat[] = [];
  for (const [i, handle] of names.entries()) {
    const r = await call(getMatch, {
      params: { id },
      session: tokens[i] as string,
    });
    seats.push({ handle, session: tokens[i] as string, side: r.body.you.side });
  }
  return { id, params: { id }, seats };
}
const at = (id: string, after?: string) =>
  `/v1/matches/${id}${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`;

describe("Mafia delta reads over HTTP", () => {
  it("answers the whole view with next, then only what's new", async () => {
    const g = await match();
    const [a, b] = g.seats as [Seat, Seat];
    const first = await call(getMatch, {
      params: g.params,
      session: a.session,
      path: at(g.id),
    });
    expect(first.status).toBe(200);
    expect(first.body.next).toMatch(/^c1\./);
    expect(first.body.you).toMatchObject({
      player: a.handle,
      can_act: true,
      moves: ["talk", "ready"],
      talks_left: 10,
    });
    const quiet = await call(getMatch, {
      params: g.params,
      session: a.session,
      path: at(g.id, first.body.next),
    });
    expect(quiet.body.events).toEqual([]);
    expect(quiet.body.resync).toBeUndefined();
    expect(quiet.body.turn).toBe(1);
    // b talks; a's delta has just that, and a's own action answers with
    // a delta too.
    await call(action, {
      params: g.params,
      session: b.session,
      body: { turn: 1, kind: "talk", text: "hello from b" },
    });
    const said = await call(action, {
      params: g.params,
      session: a.session,
      path: `${at(g.id, quiet.body.next)}`,
      body: { turn: 1, kind: "talk", text: "hello from a" },
    });
    expect(said.status).toBe(200);
    expect(
      said.body.events.map((e: { untrusted_text: string }) => e.untrusted_text),
    ).toEqual(["hello from b", "hello from a"]);
    expect(said.body.you.talks_left).toBe(9);
    const after = await call(getMatch, {
      params: g.params,
      session: a.session,
      path: at(g.id, said.body.next),
    });
    expect(after.body.events).toEqual([]);
    // An action without after still answers the whole view, as before.
    const whole = await call(action, {
      params: g.params,
      session: a.session,
      body: { turn: 1, kind: "ready" },
    });
    expect(whole.body.events.length).toBeGreaterThan(3);
    expect(whole.body.next).toMatch(/^c1\./);
  });

  it("keeps the night with the mafia, through reads and cursors", async () => {
    const g = await match();
    const mafia = g.seats.filter((s) => s.side === "mafia");
    const village = g.seats.filter((s) => s.side === "village");
    expect(mafia).toHaveLength(2);
    const cursors = new Map<string, string>();
    for (const s of g.seats)
      cursors.set(
        s.handle,
        (
          await call(getMatch, {
            params: g.params,
            session: s.session,
            path: at(g.id),
          })
        ).body.next,
      );
    for (const s of g.seats)
      await call(action, {
        params: g.params,
        session: s.session,
        body: { turn: 1, kind: "ready" },
      });
    for (const s of g.seats)
      await call(action, {
        params: g.params,
        session: s.session,
        body: { turn: 2, kind: "vote", target: null },
      });
    const plan = "NIGHTPLAN-kill-at-dawn";
    for (const m of mafia)
      await call(action, {
        params: g.params,
        session: m.session,
        body: { turn: 3, kind: "talk", text: `${plan} from ${m.handle}` },
      });
    // Every village seat: its own delta, a mafia's cursor, and the public
    // reader's, all without the night.
    for (const v of village) {
      const own = await call(getMatch, {
        params: g.params,
        session: v.session,
        path: at(g.id, cursors.get(v.handle)),
      });
      expect(own.body.resync).toBeUndefined();
      expect(own.text).not.toContain(plan);
      const stolen = await call(getMatch, {
        params: g.params,
        session: v.session,
        path: at(g.id, cursors.get(mafia[0]?.handle as string)),
      });
      expect(stolen.status).toBe(200);
      expect(stolen.body.resync).toBe(true);
      expect(stolen.text).not.toContain(plan);
      expect(stolen.body.you.side).toBe("village");
      // Whatever it's told, the village seat's cursor counts the same
      // events whether or not the mafia talked: it is opaque and the same
      // size as the mafia's.
      expect(own.body.next.length).toBe(
        cursors.get(mafia[0]?.handle as string)?.length,
      );
    }
    const anon = await call(getMatch, {
      params: g.params,
      path: at(g.id, cursors.get(mafia[0]?.handle as string)),
    });
    expect(anon.body.resync).toBe(true);
    expect(anon.text).not.toContain(plan);
    expect(anon.text).not.toContain('"side":"mafia"');
    for (const m of mafia) {
      const r = await call(getMatch, {
        params: g.params,
        session: m.session,
        path: at(g.id, cursors.get(m.handle)),
      });
      expect(r.text).toContain(plan);
      expect(r.body.you.partners).toHaveLength(1);
    }
  });

  it("resyncs forged cursors, refuses absurd ones, and binds to the match", async () => {
    const g = await match();
    const h = await match(handles.map((p) => `${p}2`));
    const [a] = g.seats as [Seat];
    const otherMatch = (
      await call(getMatch, {
        params: h.params,
        session: h.seats[0]?.session,
        path: at(h.id),
      })
    ).body.next as string;
    const whole = await call(getMatch, {
      params: g.params,
      session: a.session,
    });
    for (const forged of ["", "0", "7", "c1.AAAA", otherMatch]) {
      const r = await call(getMatch, {
        params: g.params,
        session: a.session,
        path: at(g.id, forged),
      });
      expect(r.status).toBe(200);
      expect(r.body.resync).toBe(true);
      expect(r.body.events).toEqual(whole.body.events);
    }
    // The same reader, the public one here, carrying a cursor from one
    // match into another: both matches show it the same number of events,
    // so only the cursor's binding to its match makes this a resync.
    const anonWhole = await call(getMatch, { params: g.params });
    const anonElsewhere = (await call(getMatch, { params: h.params })).body
      .next as string;
    const moved = await call(getMatch, {
      params: g.params,
      path: at(g.id, anonElsewhere),
    });
    expect(moved.body.resync).toBe(true);
    expect(moved.body.events).toEqual(anonWhole.body.events);
    expect(moved.body.events.length).toBeGreaterThan(0);
    const long = await call(getMatch, {
      params: g.params,
      session: a.session,
      path: at(g.id, "c".repeat(201)),
    });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe("invalid_cursor");
    const act = await call(action, {
      params: g.params,
      session: a.session,
      path: at(g.id, "c".repeat(201)),
      body: { turn: 1, kind: "ready" },
    });
    expect(act.body.error.code).toBe("invalid_cursor");
    // The refused action wrote nothing.
    const still = await call(getMatch, {
      params: g.params,
      session: a.session,
    });
    expect(still.body.you.can_act).toBe(true);
  });

  it("carries one notice in every answer, and none on the talk", async () => {
    const g = await match();
    const [a, b] = g.seats as [Seat, Seat];
    await call(action, {
      params: g.params,
      session: b.session,
      body: { turn: 1, kind: "talk", text: "first words" },
    });
    const whole = await call(getMatch, {
      params: g.params,
      session: a.session,
    });
    const answers = [
      whole,
      await call(getMatch, { params: g.params }),
      await call(getMatch, {
        params: g.params,
        session: a.session,
        path: at(g.id, whole.body.next),
      }),
      await call(getMatch, {
        params: g.params,
        session: a.session,
        path: at(g.id, "c1.forged"),
      }),
      await call(getMatch, {
        params: g.params,
        session: a.session,
        path: `${at(g.id, whole.body.next)}&wait=1`,
      }),
      await call(action, {
        params: g.params,
        session: a.session,
        body: { turn: 1, kind: "talk", text: "second words" },
      }),
      await call(action, {
        params: g.params,
        session: a.session,
        path: at(g.id, whole.body.next),
        body: { turn: 1, kind: "talk", text: "third words" },
      }),
    ];
    const notice = whole.body.notice as string;
    expect(notice).toMatch(/untrusted/i);
    for (const r of answers) {
      expect(r.status).toBe(200);
      expect(r.body.notice).toBe(notice);
      expect(r.text.split(notice)).toHaveLength(2);
      for (const e of r.body.events) expect(e).not.toHaveProperty("notice");
    }
    expect(answers[4]?.body.events).toEqual([]);
    expect(
      answers[6]?.body.events.map(
        (e: { untrusted_text: string }) => e.untrusted_text,
      ),
    ).toEqual(["second words", "third words"]);
  });
});
