import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { sealOf } from "@unprompted-tables/game";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as commitRoute } from "@/app/v1/matches/[id]/commit/route";
import { POST as revealRoute } from "@/app/v1/matches/[id]/reveal/route";
import { GET as meRoute } from "@/app/v1/me/route";
import { POST as leaveRoute } from "@/app/v1/queue/leave/route";
import { POST as queueRoute } from "@/app/v1/queue/route";
import {
  DELETE as endRoute,
  POST as sessionRoute,
} from "@/app/v1/sessions/route";
import { sealFields } from "@/lib/match";
import { call, countRows, resetDb, sessionFor } from "./helpers";

// Every route that changes anything takes its player from a session, and
// every one but ending a session is closed by the kill switch. The list
// below must name every write route the app has, so a new one can't slip
// past these checks.

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});

type Handler = (req: Request, ctx: never) => Promise<Response>;
type Opts = Parameters<typeof call>[1];

const writes = (id: string): Record<string, [Handler, Opts]> => ({
  "POST /v1/queue": [queueRoute, { body: {} }],
  "POST /v1/queue/leave": [leaveRoute, { body: {} }],
  "POST /v1/matches/[id]/commit": [
    commitRoute,
    { params: { id }, body: { round: 1, seal: "a".repeat(64) } },
  ],
  "POST /v1/matches/[id]/reveal": [
    revealRoute,
    {
      params: { id },
      body: { round: 1, move: "rock", salt: "x".repeat(16) },
    },
  ],
  "DELETE /v1/sessions": [endRoute, { method: "DELETE" }],
});

// The one write that needs no session: it's how a player gets one.
const KEYLESS = ["POST /v1/sessions"];

function writeRoutes(): string[] {
  const root = path.join(process.cwd(), "src/app");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const text = readFileSync(full, "utf8");
        const url = `/${path.relative(root, dir).split(path.sep).join("/")}`;
        for (const m of text.matchAll(
          /export const (POST|PUT|PATCH|DELETE)\b/g,
        ))
          found.push(`${m[1]} ${url}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

async function pair() {
  const a = { handle: "ruby", session: await sessionFor("ruby") };
  const b = { handle: "jade", session: await sessionFor("jade") };
  await call(queueRoute, { session: a.session, body: {} });
  const res = await call(queueRoute, { session: b.session, body: {} });
  return { id: res.body.match as string, a, b };
}

describe("deny by default", () => {
  it("covers every write route the app has", () => {
    expect(writeRoutes()).toEqual(
      [...Object.keys(writes("x")), ...KEYLESS].sort(),
    );
  });

  it("refuses every write with no session, or one that isn't real", async () => {
    const { id } = await pair();
    const before = await countRows("events");
    for (const [name, [handler, opts]] of Object.entries(writes(id))) {
      const none = await call(handler, opts);
      expect(none.status, name).toBe(401);
      expect(none.body.error.code, name).toBe("missing_session");
      const made = await call(handler, {
        ...opts,
        session: `rps_${"b".repeat(22)}`,
      });
      expect(made.status, name).toBe(401);
      expect(made.body.error.code, name).toBe("invalid_session");
      // An Unprompted key isn't a session here either.
      const key = await call(handler, {
        ...opts,
        session: `unp_${"c".repeat(43)}`,
      });
      expect(key.status, name).toBe(401);
    }
    expect((await call(meRoute)).status).toBe(401);
    expect(await countRows("events")).toBe(before);
    expect(await countRows("sessions")).toBe(2);
  });

  it("closes every write but ending a session under the kill switch", async () => {
    const { id, a } = await pair();
    const before = await countRows("events");
    process.env.TABLE_READ_ONLY = "1";
    const salt = "salt-ruby-1-0000000000";
    const seal = sealOf(sealFields(id, 1, "ruby", "rock", salt));
    for (const [name, res] of [
      ["queue", await call(queueRoute, { session: a.session, body: {} })],
      ["leave", await call(leaveRoute, { session: a.session, body: {} })],
      [
        "commit",
        await call(commitRoute, {
          session: a.session,
          params: { id },
          body: { round: 1, seal },
        }),
      ],
      [
        "reveal",
        await call(revealRoute, {
          session: a.session,
          params: { id },
          body: { round: 1, move: "rock", salt },
        }),
      ],
      [
        "session",
        await call(sessionRoute, { body: { pass: `pass_${"a".repeat(22)}` } }),
      ],
    ] as const) {
      expect(res.status, name).toBe(503);
      expect(res.body.error.code, name).toBe("read_only");
    }
    expect(await countRows("events")).toBe(before);
    expect((await call(meRoute, { session: a.session })).status).toBe(200);
    const ended = await call(endRoute, {
      session: a.session,
      method: "DELETE",
    });
    expect(ended.status).toBe(200);
    expect((await call(meRoute, { session: a.session })).status).toBe(401);
  });
});

describe("ending a session", () => {
  it("ends only the session it's sent with", async () => {
    const first = await sessionFor("ruby");
    const second = await sessionFor("ruby");
    const res = await call(endRoute, { session: first, method: "DELETE" });
    expect(res.body).toEqual({ player: "ruby", ended: true });
    expect((await call(meRoute, { session: first })).status).toBe(401);
    expect((await call(meRoute, { session: second })).status).toBe(200);
    // Ending it twice is refused like any session that isn't real.
    expect(
      (await call(endRoute, { session: first, method: "DELETE" })).status,
    ).toBe(401);
    expect(await countRows("sessions")).toBe(1);
  });
});
