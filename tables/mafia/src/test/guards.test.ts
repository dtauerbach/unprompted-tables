import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST as action } from "@/app/v1/matches/[id]/actions/route";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as me } from "@/app/v1/me/route";
import { POST as leave } from "@/app/v1/queue/leave/route";
import { POST as queue } from "@/app/v1/queue/route";
import { DELETE as revoke, POST as session } from "@/app/v1/sessions/route";
import { moveClock } from "@/lib/clock";
import { route } from "@/lib/http";
import { startMatch, withMatch } from "@/lib/store";
import { call, countRows, fakeSite, resetDb, sessionFor } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
  vi.restoreAllMocks();
});
type Handler = (req: Request, ctx: never) => Promise<Response>;
type Opts = Parameters<typeof call>[1];
const writes: Record<string, [Handler, Opts]> = {
  "POST /v1/queue": [queue, { method: "POST" }],
  "POST /v1/queue/leave": [leave, { method: "POST" }],
  "POST /v1/matches/[id]/actions": [
    action,
    { params: { id: "m_aaaaaaaaaaaa" }, body: { kind: "ready", turn: 1 } },
  ],
  "DELETE /v1/sessions": [revoke, { method: "DELETE" }],
};
// The write methods a route file exports, in any form Next.js accepts.
function writeExports(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(
    /export\s+(?:const|(?:async\s+)?function)\s+(POST|PUT|PATCH|DELETE)\b/g,
  ))
    found.push(m[1] ?? "");
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g))
    for (const name of (m[1] ?? "").matchAll(
      /\bas\s+(POST|PUT|PATCH|DELETE)\b/g,
    ))
      found.push(name[1] ?? "");
  return found;
}

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
        for (const method of writeExports(text)) found.push(`${method} ${url}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

it("discovers all writes, with only session creation keyless", async () => {
  expect(writeRoutes()).toEqual(
    [...Object.keys(writes), "POST /v1/sessions"].sort(),
  );
  expect(
    writeExports(
      "export const POST=x; export async function PUT(){}; export function PATCH(){}; export { x as DELETE };",
    ).sort(),
  ).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
  for (const [name, [handler, opts]] of Object.entries(writes)) {
    for (const token of [
      undefined,
      `mafia_${"b".repeat(22)}`,
      `unp_${"c".repeat(43)}`,
    ])
      expect(
        (await call(handler, { ...opts, session: token })).status,
        name,
      ).toBe(401);
  }
  expect(await countRows("events")).toBe(0);
});
it("kill switch covers every write except revocation, with identity checked first", async () => {
  const token = await sessionFor("alice");
  process.env.TABLE_READ_ONLY = "1";
  for (const [name, [handler, opts]] of Object.entries(writes)) {
    if (name.startsWith("DELETE")) continue;
    expect((await call(handler, opts)).status, name).toBe(401);
    expect(
      (await call(handler, { ...opts, session: token })).status,
      name,
    ).toBe(503);
  }
  expect((await call(session, { body: { pass: "pass_unused" } })).status).toBe(
    503,
  );
  expect(await countRows("events")).toBe(0);
  expect(
    (await call(revoke, { session: token, method: "DELETE" })).status,
  ).toBe(200);
});
it("refuses expired sessions and malformed or absent match IDs", async () => {
  const token = await sessionFor("alice");
  moveClock(86_400_001);
  expect((await call(me, { session: token })).status).toBe(401);
  for (const id of ["bad-id", "m_aaaaaaaaaaaa"])
    expect((await call(getMatch, { params: { id } })).status).toBe(404);
});
it("redeems using only the Table key and returns 503 when the site is down", async () => {
  const site = fakeSite();
  try {
    expect(
      (await call(session, { body: { pass: site.pass("alice") } })).status,
    ).toBe(201);
    expect(new Headers(site.calls[0]?.init?.headers).get("authorization")).toBe(
      `Bearer ${process.env.UNPROMPTED_KEY}`,
    );
    site.setDown(true);
    expect(
      (await call(session, { body: { pass: site.pass("bobby") } })).status,
    ).toBe(503);
    expect(await countRows("sessions")).toBe(1);
  } finally {
    site.restore();
  }
});
it("a rate-limited action writes neither events nor quota", async () => {
  const token = await sessionFor("alice");
  const id = await db().begin((tx) =>
    startMatch(tx, [
      "alice",
      "bobby",
      "carol",
      "david",
      "ellen",
      "frank",
      "grace",
    ]),
  );
  await db()`INSERT INTO rate_limits(bucket,window_start,count) VALUES ('move:alice',to_timestamp(floor(extract(epoch FROM now()) / 3600)*3600),600)`;
  const before = await countRows("events");
  expect(
    (
      await call(action, {
        session: token,
        params: { id },
        body: { kind: "ready", turn: 1 },
      })
    ).status,
  ).toBe(429);
  expect(await countRows("events")).toBe(before);
  expect(
    (await db()`SELECT count FROM rate_limits WHERE bucket='move:alice'`)[0]
      ?.count,
  ).toBe(600);
});
it("rejects malformed public and private talk before storage or error logging", async () => {
  const id = await db().begin((tx) =>
    startMatch(tx, [
      "alice",
      "bobby",
      "carol",
      "david",
      "ellen",
      "frank",
      "grace",
    ]),
  );
  const mafia = await withMatch(id, async (s) => ({
    events: [],
    value: s.players.find((p) => s.roles[p] === "mafia") as string,
  }));
  const token = await sessionFor(mafia);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const turn of [1, 3]) {
    if (turn === 3) moveClock(180_000);
    await call(getMatch, { params: { id }, session: token });
    const before = await countRows("events");
    for (const bad of [
      "\u0000",
      "\ud800",
      "\udc00",
      "\u0001",
      "\u000b",
      "\u000c",
      "\u001f",
      "\u007f",
    ]) {
      const res = await call(action, {
        params: { id },
        session: token,
        body: { kind: "talk", turn, text: `private${bad}secret` },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("private");
    }
    expect(await countRows("events")).toBe(before);
    expect(logged).not.toHaveBeenCalled();
    expect(
      (
        await call(action, {
          params: { id },
          session: token,
          body: { kind: "talk", turn, text: "hello 😀\n\tworld" },
        })
      ).status,
    ).toBe(200);
  }
  await expect(
    db()`UPDATE events SET seq=seq WHERE match_id=${id}`,
  ).rejects.toThrow();
  await expect(db()`DELETE FROM events WHERE match_id=${id}`).rejects.toThrow();
});
it("redacts unexpected internal errors before the shared logger", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const handler = route(async () => {
    throw Object.assign(new Error("private night content"), {
      parameters: ["secret roles"],
    });
  });
  expect((await call(handler, { path: "/v1" })).status).toBe(500);
  expect(logged).toHaveBeenCalled();
  expect(JSON.parse(logged.mock.calls[0]?.[0])).toMatchObject({
    operation: "/v1",
    name: "Error",
  });
  expect(String(logged.mock.calls[0]?.[0])).not.toContain("private night");
  expect(JSON.stringify(logged.mock.calls)).not.toContain("secret roles");
});
