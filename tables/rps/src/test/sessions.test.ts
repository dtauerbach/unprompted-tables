import { db, hashToken } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as meRoute } from "@/app/v1/me/route";
import { GET as describeRoute } from "@/app/v1/route";
import { POST as sessionRoute } from "@/app/v1/sessions/route";
import { moveClock } from "@/lib/clock";
import { LIMITS } from "@/lib/limits";
import { SETTINGS } from "@/lib/settings";
import { call, countRows, fakeSite, join, resetDb } from "./helpers";

let site: ReturnType<typeof fakeSite>;
beforeEach(async () => {
  await resetDb();
  site = fakeSite();
});
afterEach(() => site.restore());

describe("the Table's description", () => {
  it("says how it plays, from its own settings", async () => {
    const res = await call(describeRoute);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      game: "rps",
      seats: [{ role: "player", min: 2, max: 2 }],
      clock: { template: "phases", seconds: SETTINGS.clock.seconds },
      joining: { bot: "rps-table", site: "https://unprompted.test" },
    });
    expect(res.body.rules.moves).toEqual(["rock", "paper", "scissors"]);
  });
});

describe("joining with a pass", () => {
  it("trades a pass for a session, checked at Unprompted with the Table's key", async () => {
    const pass = site.pass("ruby");
    const res = await call(sessionRoute, { body: { pass } });
    expect(res.status).toBe(201);
    expect(res.body.player).toBe("ruby");
    expect(res.body.session).toMatch(/^rps_[A-Za-z0-9_-]{22}$/);
    expect(site.calls).toHaveLength(1);
    const [{ url, init }] = site.calls as [(typeof site.calls)[0]];
    expect(url).toBe("https://unprompted.test/v1/passes/redeem");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer unp_the-tables-own-key-for-tests",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ pass });
    // Only the session's hash is kept.
    const rows = await db()<{ player: string; token_hash: string }[]>`
      SELECT player, token_hash FROM sessions`;
    expect(rows).toEqual([
      { player: "ruby", token_hash: hashToken(res.body.session) },
    ]);
    const me = await call(meRoute, { session: res.body.session });
    expect(me.body).toEqual({ player: "ruby", status: "idle" });
  });

  it("takes a pass once", async () => {
    const pass = site.pass("ruby");
    expect((await call(sessionRoute, { body: { pass } })).status).toBe(201);
    const again = await call(sessionRoute, { body: { pass } });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("invalid_pass");
  });

  it("never sends the site anything that isn't a pass", async () => {
    for (const pass of [
      "unp_this-is-somebodys-key",
      "pass_short",
      `pass_${"a".repeat(22)}/../../v1/me`,
      "",
    ]) {
      const res = await call(sessionRoute, { body: { pass } });
      expect(res.status, pass).toBe(400);
    }
    for (const body of [{}, { pass: "x", player: "ruby" }, { handle: "ruby" }])
      expect((await call(sessionRoute, { body })).status).toBe(400);
    expect(site.calls).toHaveLength(0);
    expect(await countRows("sessions")).toBe(0);
  });

  it("says the site is unavailable when it can't check a pass, and makes nothing", async () => {
    site.setDown(true);
    const res = await call(sessionRoute, { body: { pass: site.pass("ruby") } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("site_unavailable");
    site.setDown(false);
    // An answer that isn't a handle is the site's failure, not a player.
    site.setAnswer(() => ({ bot: { handle: "Robert'); DROP TABLE" } }));
    expect(
      (await call(sessionRoute, { body: { pass: site.pass("ruby") } })).status,
    ).toBe(503);
    site.setAnswer(() => ({ bot: "ruby" }));
    expect(
      (await call(sessionRoute, { body: { pass: site.pass("ruby") } })).status,
    ).toBe(503);
    expect(await countRows("sessions")).toBe(0);
  });

  it("counts every try from an address, even failed ones", async () => {
    const ip = "10.200.0.1";
    for (let i = 0; i < LIMITS.sessionPerIp.limit; i++)
      await call(sessionRoute, {
        ip,
        body: { pass: `pass_${"b".repeat(22)}` },
      });
    const over = await call(sessionRoute, {
      ip,
      body: { pass: site.pass("ruby") },
    });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBeTruthy();
    // Another address is fine.
    expect(
      (await call(sessionRoute, { body: { pass: site.pass("ruby") } })).status,
    ).toBe(201);
  });

  it("refuses a missing, made-up or expired session", async () => {
    expect((await call(meRoute)).status).toBe(401);
    for (const session of [
      "rps_aaaaaaaaaaaaaaaaaaaaaa",
      "unp_somebodys-key",
      "rps_",
    ]) {
      const res = await call(meRoute, { session });
      expect(res.status, session).toBe(401);
      expect(res.body.error.code).toBe("invalid_session");
    }
    const ruby = await join(site, "ruby");
    moveClock((SETTINGS.session_seconds + 1) * 1000);
    expect((await call(meRoute, { session: ruby.session })).status).toBe(401);
  });

  it("refuses new sessions while read-only", async () => {
    process.env.TABLE_READ_ONLY = "1";
    try {
      const res = await call(sessionRoute, {
        body: { pass: site.pass("ruby") },
      });
      expect(res.status).toBe(503);
      expect(site.calls).toHaveLength(0);
    } finally {
      delete process.env.TABLE_READ_ONLY;
    }
  });
});
