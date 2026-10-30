import { randomBytes } from "node:crypto";
import { db, newToken } from "@unprompted-tables/server";
import { vi } from "vitest";
import { POST as sessionRoute } from "@/app/v1/sessions/route";
import { now, resetClock } from "@/lib/clock";

export async function resetDb(): Promise<void> {
  await db()`TRUNCATE sessions, players, queue, lobby, matches, open_matches, events, results, rate_limits CASCADE`;
  resetClock();
}

// What the site says about a bot when its pass is redeemed: a month-old,
// unclaimed account unless a test says otherwise.
export function holderOf(handle: string, over: Record<string, unknown> = {}) {
  return {
    handle,
    is_new: false,
    claimed: false,
    created_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    web_url: `/b/${handle}`,
    ...over,
  };
}

// A stand-in for Unprompted's pass check: passes it made, for the handle
// each proves, used once. Every call it gets is kept for tests to inspect.
export function fakeSite() {
  const passes = new Map<string, string>();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let down = false;
  let answer: ((handle: string) => unknown) | null = null;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (down) throw new TypeError("fetch failed");
      const { pass } = JSON.parse(String(init?.body ?? "{}"));
      const handle = passes.get(pass);
      if (!handle)
        return Response.json(
          { error: { code: "invalid_pass", message: "no" } },
          { status: 400 },
        );
      passes.delete(pass);
      return Response.json(answer ? answer(handle) : { bot: holderOf(handle) });
    });
  return {
    calls,
    pass(handle: string): string {
      const p = `pass_${randomBytes(16).toString("base64url")}`;
      passes.set(p, handle);
      return p;
    },
    setDown(v: boolean) {
      down = v;
    },
    setAnswer(fn: ((handle: string) => unknown) | null) {
      answer = fn;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

let ipCounter = 0;
export function freshIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

export async function call<C>(
  handler: (req: Request, ctx: C) => Promise<Response>,
  opts: {
    body?: unknown;
    rawBody?: string;
    session?: string;
    ip?: string;
    path?: string;
    method?: string;
    params?: Record<string, string>;
  } = {},
  // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary response JSON
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? freshIp() };
  if (opts.session) headers.authorization = `Bearer ${opts.session}`;
  const body =
    opts.rawBody ??
    (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://mafia.test${opts.path ?? "/"}`, {
    method: opts.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body,
  });
  const ctx = { params: Promise.resolve(opts.params ?? {}) } as unknown as C;
  const res = await handler(req, ctx);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

// A player with a session, the way a bot gets one.
export async function join(
  site: ReturnType<typeof fakeSite>,
  handle: string,
): Promise<{ handle: string; session: string }> {
  const res = await call(sessionRoute, { body: { pass: site.pass(handle) } });
  if (res.status !== 201)
    throw new Error(
      `join ${handle}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  return { handle, session: res.body.session };
}

// A session made straight in the database, for tests that don't care how,
// for a player whose Unprompted account is a month old unless it says.
export async function sessionFor(
  handle: string,
  onSiteSince = "30 days",
): Promise<string> {
  const { token, hash } = newToken("mafia_");
  await db()`
    INSERT INTO players (handle, on_site_since)
    VALUES (${handle}, now() - ${onSiteSince}::interval)
    ON CONFLICT (handle) DO NOTHING`;
  await db()`
    INSERT INTO sessions (player, token_hash, expires_at)
    VALUES (${handle}, ${hash}, ${new Date(now().getTime() + 86_400_000)})`;
  return token;
}

export async function countRows(table: string): Promise<number> {
  const [row] = await db().unsafe(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(row?.n);
}
