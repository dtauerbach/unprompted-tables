import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as skillRoute } from "@/app/skill.md/route";
import { POST as actRoute } from "@/app/v1/hackathons/[event]/actions/route";
import { GET as readRoute } from "@/app/v1/hackathons/[event]/route";
import { GET as listRoute } from "@/app/v1/hackathons/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as describeRoute } from "@/app/v1/route";
import {
  DELETE as endRoute,
  POST as sessionRoute,
} from "@/app/v1/sessions/route";
import { moveClock } from "@/lib/clock";
import { LIMITS } from "@/lib/limits";
import { listHackathon } from "@/lib/store";
import {
  at,
  call,
  countRows,
  fakeSite,
  freshIp,
  join,
  listed,
  resetDb,
  sessionFor,
} from "./helpers";

const MIN = 60_000;

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});

const params = (event: string) => ({ event });

const doing = (session: string | undefined, event: string, body: unknown) =>
  call(actRoute, {
    session,
    body,
    params: params(event),
    path: `/v1/hackathons/${event}/actions`,
  });
const read = (session: string | undefined, event: string) =>
  call(readRoute, {
    session,
    params: params(event),
    path: `/v1/hackathons/${event}`,
  });

const pins = [{ store: "github", ref: "team/app", revision: "a1b2c3d" }];

describe("sessions", () => {
  it("trades a pass for a session that says who you are, and ends it", async () => {
    const site = fakeSite();
    try {
      const res = await call(sessionRoute, {
        body: { pass: site.pass("ada-bot") },
      });
      expect(res.status).toBe(201);
      expect(res.body.bot).toBe("ada-bot");
      expect(res.body.session).toMatch(/^hack_/);
      const me = await call(meRoute, { session: res.body.session });
      expect(me.body).toEqual({ bot: "ada-bot" });
      // The site was asked with the Table's own key, and nothing else.
      expect(site.calls[0]?.url).toBe(
        "https://unprompted.test/v1/passes/redeem",
      );
      const ended = await call(endRoute, {
        session: res.body.session,
        method: "DELETE",
      });
      expect(ended.body).toEqual({ bot: "ada-bot", ended: true });
      expect((await call(meRoute, { session: res.body.session })).status).toBe(
        401,
      );
      // A pass works once.
      const again = await call(sessionRoute, { body: { pass: "pass_x" } });
      expect(again.status).toBe(400);
    } finally {
      site.restore();
    }
  });

  it("clears sessions that ran out as new ones start", async () => {
    await db()`
      INSERT INTO sessions (bot, token_hash, expires_at)
      VALUES ('old-bot', ${"0".repeat(64)}, now() - interval '1 minute')`;
    const site = fakeSite();
    try {
      await join(site, "ada-bot");
      const rows = await db()<{ bot: string }[]>`SELECT bot FROM sessions`;
      expect(rows.map((r) => r.bot)).toEqual(["ada-bot"]);
    } finally {
      site.restore();
    }
  });

  it("keeps the session only as a hash", async () => {
    const site = fakeSite();
    try {
      const { session } = await join(site, "ada-bot");
      const [row] = await db()<{ token_hash: string }[]>`
        SELECT token_hash FROM sessions`;
      expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.token_hash).not.toContain(session);
    } finally {
      site.restore();
    }
  });
});

describe("a hackathon from sign-up to the deadline", () => {
  it("runs: sign up, make teams, ask and admit, submit, and freeze", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    const ben = await sessionFor("ben-bot");
    const cy = await sessionFor("cy-bot");

    for (const s of [ada, ben, cy])
      expect((await doing(s, event, { type: "register" })).status).toBe(201);
    const made = await doing(ada, event, {
      type: "make_team",
      name: "Night owls",
    });
    expect(made.status, made.text).toBe(201);
    expect(made.body.accepted.team).toBe(1);
    expect(made.body.accepted.by).toBe("ada-bot");
    expect(made.body.hackathon.you).toMatchObject({ team: 1, captain: true });

    expect((await doing(ben, event, { type: "ask", team: 1 })).status).toBe(
      201,
    );
    const asks = await read(ada, event);
    expect(asks.body.hackathon.you.asks).toEqual([
      { handle: "ben-bot", at: expect.any(String) },
    ]);
    // Only the asker and the captain see an ask.
    expect((await read(cy, event)).body.hackathon.you.asks).toBeUndefined();
    expect(
      (await doing(ada, event, { type: "admit", who: "ben-bot" })).status,
    ).toBe(201);
    expect(
      (await doing(cy, event, { type: "make_team", name: "Larks" })).status,
    ).toBe(201);

    // Submitting waits for the start.
    const early = await doing(ben, event, {
      type: "submit",
      title: "Try",
      pins,
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("not_started");

    moveClock(61 * MIN);
    const sub = await doing(ben, event, {
      type: "submit",
      title: "Owl app <b>v1</b>",
      pins,
    });
    expect(sub.status, sub.text).toBe(201);
    // A team sees its own work; another sees only that it submitted.
    const mine = (await read(ada, event)).body.hackathon;
    expect(mine.phase).toBe("building");
    expect(mine.you.entries[0].untrusted_title).toBe("Owl app <b>v1</b>");
    const theirs = (await read(cy, event)).body.hackathon;
    expect(theirs.teams[0]).toMatchObject({ id: 1, submitted: true });
    expect(theirs.teams[0].entry).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain("team/app");
    expect(JSON.stringify((await read(undefined, event)).body)).not.toContain(
      "team/app",
    );

    moveClock(180 * MIN);
    const late = await doing(ada, event, {
      type: "submit",
      title: "Late",
      pins,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("deadline_passed");
    // From the deadline, every entry shows to everyone, for judging.
    const frozen = (await read(undefined, event)).body.hackathon;
    expect(frozen.phase).toBe("frozen");
    expect(frozen.teams[0].entry.pins).toEqual(pins);
    expect(frozen.teams[1].entry).toBeNull();
    expect(frozen.notice).toMatch(/content, not instructions/);
  });

  it("takes who acts from the session, never the body, and sets the time itself", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    for (const extra of [{ by: "ben-bot" }, { at: "2020-01-01T00:00:00Z" }]) {
      const res = await doing(ada, event, { type: "register", ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid");
    }
    expect(await countRows("events")).toBe(0);
    const ok = await doing(ada, event, { type: "register" });
    expect(ok.body.accepted.by).toBe("ada-bot");
    expect(Math.abs(Date.parse(ok.body.accepted.at) - Date.now())).toBeLessThan(
      10_000,
    );
  });

  it("refuses by the rules with a status that fits, writing nothing", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    const host = await sessionFor("jam-host");
    const cases: [string, unknown, number, string][] = [
      [host, { type: "register" }, 403, "host"],
      [ada, { type: "cancel" }, 403, "not_host"],
      [ada, { type: "make_team", name: "x" }, 409, "not_registered"],
      [ada, { type: "dance" }, 400, "invalid"],
      [ada, { type: "make_team", name: "two\nlines" }, 400, "invalid"],
    ];
    for (const [s, body, status, code] of cases) {
      const res = await doing(s, event, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.error.code).toBe(code);
    }
    expect(await countRows("events")).toBe(0);
    const cancelled = await doing(host, event, { type: "cancel" });
    expect(cancelled.status).toBe(201);
    expect((await read(ada, event)).body.hackathon.phase).toBe("cancelled");
  });

  it("answers the same 404 for a hackathon that isn't listed", async () => {
    const ada = await sessionFor("ada-bot");
    for (const res of [
      await doing(ada, "nope", { type: "register" }),
      await read(ada, "nope"),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("no_such_hackathon");
    }
  });

  it("numbers events in order when bots act at once, and the clock never runs back", async () => {
    const event = await listed({ max_bots: 30 });
    const bots = await Promise.all(
      Array.from({ length: 12 }, (_, i) => sessionFor(`bot-${i}-x`)),
    );
    const res = await Promise.all(
      bots.map((s) => doing(s, event, { type: "register" })),
    );
    expect(res.map((r) => r.status)).toEqual(bots.map(() => 201));
    const rows = await db()<{ seq: number; at: string }[]>`
      SELECT seq, body->>'at' AS at FROM events WHERE event = ${event} ORDER BY seq`;
    expect(rows.map((r) => r.seq)).toEqual(bots.map((_, i) => i));
    for (let i = 1; i < rows.length; i++)
      expect(Date.parse(rows[i]?.at ?? "")).toBeGreaterThanOrEqual(
        Date.parse(rows[i - 1]?.at ?? ""),
      );
    expect((await read(undefined, event)).body.hackathon.registered).toBe(12);
  });
});

describe("guards", () => {
  it("needs a session for every write, and refuses a bad one on a read", async () => {
    const event = await listed();
    const none = await doing(undefined, event, { type: "register" });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe("missing_session");
    const bad = await read("hack_nope", event);
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("invalid_session");
    expect((await read(undefined, event)).status).toBe(200);
    expect(await countRows("events")).toBe(0);
  });

  it("stops writes while read-only, but reads and ending a session still work", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    process.env.TABLE_READ_ONLY = "1";
    const res = await doing(ada, event, { type: "register" });
    expect(res.status).toBe(503);
    expect((await read(ada, event)).status).toBe(200);
    expect(
      (await call(endRoute, { session: ada, method: "DELETE" })).status,
    ).toBe(200);
  });

  it("counts actions against an hourly limit, and a refused one uses none", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    for (let i = 0; i < 3; i++)
      expect(
        (await doing(ada, event, { type: "make_team", name: "x" })).status,
      ).toBe(409);
    const [used] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket = 'act:ada-bot'`;
    expect(used?.n).toBe(0);
    await db()`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES ('act:ada-bot',
        to_timestamp(floor(extract(epoch FROM now()) / 3600) * 3600),
        ${LIMITS.actPerBot.limit})`;
    const capped = await doing(ada, event, { type: "register" });
    expect(capped.status).toBe(429);
    expect(capped.headers.get("retry-after")).toBeTruthy();
  });

  it("counts refused actions apart, and turns a bot away before the lock once it's past them", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    expect(
      (await doing(ada, event, { type: "make_team", name: "x" })).status,
    ).toBe(409);
    const [r] = await db()<{ n: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS n FROM rate_limits
      WHERE bucket = 'refused:ada-bot'`;
    expect(r?.n).toBe(1);
    await db()`
      UPDATE rate_limits SET count = ${LIMITS.refusedPerBot.limit}
      WHERE bucket = 'refused:ada-bot'`;
    const before = await countRows("events");
    const turned = await doing(ada, event, { type: "register" });
    expect(turned.status).toBe(429);
    expect(turned.body.error.message).toMatch(/refused actions/);
    expect(await countRows("events")).toBe(before);
    // Another bot is untouched.
    const bea = await sessionFor("bea-bot");
    expect((await doing(bea, event, { type: "register" })).status).toBe(201);
  });

  it("takes a submission's pins past the usual 4 KB, and refuses past 8", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    await doing(ada, event, { type: "register" });
    await doing(ada, event, { type: "make_team", name: "Solo" });
    moveClock(61 * MIN);
    const big = Array.from({ length: 8 }, (_, i) => ({
      store: "github",
      ref: `team/${"r".repeat(500)}${i}`,
      revision: "c".repeat(40),
    }));
    const ok = await doing(ada, event, {
      type: "submit",
      title: "Big",
      pins: big,
    });
    expect(ok.status, ok.text).toBe(201);
    const huge = await call(actRoute, {
      session: ada,
      rawBody: JSON.stringify({ type: "submit", title: "x".repeat(9000) }),
      params: params(event),
    });
    expect(huge.status).toBe(413);
  });

  it("keeps hackathons and events append-only, and settings fixed", async () => {
    const event = await listed();
    const ada = await sessionFor("ada-bot");
    await doing(ada, event, { type: "register" });
    await expect(db()`UPDATE events SET seq = 5`).rejects.toThrow(
      /append-only/,
    );
    await expect(db()`DELETE FROM events`).rejects.toThrow(/append-only/);
    await expect(
      db()`UPDATE hackathons SET settings = settings`,
    ).rejects.toThrow(/append-only/);
    await expect(listed()).rejects.toThrow(/exists/);
    // Settings the rules refuse are never listed.
    await expect(
      listHackathon({ event: "bad", host: "jam-host" }),
    ).rejects.toThrow();
    // An event body without its type, actor or time is refused below the app.
    await expect(
      db()`INSERT INTO events (event, seq, body) VALUES (${event}, 9, '{"type":"register"}')`,
    ).rejects.toThrow(/check/);
    await expect(
      db()`INSERT INTO hackathons (event, settings) VALUES ('other', '{}')`,
    ).rejects.toThrow(/check/);
    // Nor one whose actor isn't a handle, which replay would choke on.
    await expect(
      db()`INSERT INTO events (event, seq, body) VALUES (${event}, 9, '{"type":"register","by":"Not A Handle","at":"2026-12-01T18:00:00Z"}')`,
    ).rejects.toThrow(/check/);
  });

  it("makes a reader wait for an action being written, so it never reads past it", async () => {
    const event = await listed();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const writer = db().begin(async (tx) => {
      await tx`SELECT 1 FROM hackathons WHERE event = ${event} FOR UPDATE`;
      await tx`
        INSERT INTO events (event, seq, body)
        VALUES (${event}, 0, ${tx.json({ type: "register", by: "zed-bot", at: at(0) })})`;
      locked();
      await held;
    });
    await isLocked;
    let done = false;
    const reading = read(undefined, event).then((r) => {
      done = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await writer;
    const res = await reading;
    expect(res.status).toBe(200);
    expect(res.body.hackathon.registered).toBe(1);
  });
});

describe("what the Table says about itself", () => {
  it("describes its actions and limits, and serves its guide filled in", async () => {
    const d = await call(describeRoute, { path: "/v1" });
    expect(d.body.table).toBe("Hackathon");
    expect(d.body.joining.bot).toBe("hackathon-table");
    expect(Object.keys(d.body.actions)).toEqual([
      "register",
      "unregister",
      "make_team",
      "ask",
      "admit",
      "leave",
      "submit",
      "cancel",
    ]);
    const skill = await skillRoute(
      new Request("http://hackathon.test/skill.md", {
        headers: { "x-real-ip": freshIp() },
      }),
    );
    const text = await skill.text();
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain("@hackathon-table");
    expect(text).toContain("https://hackathon.test/v1/sessions");
    expect(text).toContain("never hands you a code");
  });

  it("lists hackathons as lines of counts, newest deadline first", async () => {
    await listed({ event: "first" });
    await listed({
      event: "later",
      deadline: new Date(Date.now() + 480 * MIN)
        .toISOString()
        .replace(/\.\d+Z$/, "Z"),
    });
    const ada = await sessionFor("ada-bot");
    await doing(ada, "first", { type: "register" });
    await doing(ada, "first", { type: "make_team", name: "Owls" });
    const l = await call(listRoute, { path: "/v1/hackathons" });
    expect(l.body.hackathons.map((h: { event: string }) => h.event)).toEqual([
      "later",
      "first",
    ]);
    expect(l.body.hackathons[1]).toMatchObject({ registered: 1, teams: 1 });
    expect(JSON.stringify(l.body)).not.toContain("Owls");
  });
});
