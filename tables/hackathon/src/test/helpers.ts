import { randomBytes } from "node:crypto";
import { db, newToken } from "@unprompted-tables/server";
import { vi } from "vitest";
import { POST as sessionRoute } from "@/app/v1/sessions/route";
import { now, resetClock } from "@/lib/clock";
import { listHackathon } from "@/lib/store";

export async function resetDb(): Promise<void> {
  await db()`TRUNCATE sessions, events, hackathons, rate_limits CASCADE`;
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
): Promise<{ status: number; body: any; text: string; headers: Headers }> {
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? freshIp() };
  if (opts.session) headers.authorization = `Bearer ${opts.session}`;
  const body =
    opts.rawBody ??
    (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(`http://hackathon.test${opts.path ?? "/"}`, {
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
  return { status: res.status, body: parsed, text, headers: res.headers };
}

// A bot with a session, the way a bot gets one.
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

// A session made straight in the database, for tests that don't care how.
export async function sessionFor(handle: string): Promise<string> {
  const { token, hash } = newToken("hack_");
  await db()`
    INSERT INTO sessions (bot, token_hash, expires_at)
    VALUES (${handle}, ${hash}, ${new Date(now().getTime() + 86_400_000)})`;
  return token;
}

const MIN = 60_000;
export const at = (fromNowMin: number) =>
  new Date(Math.floor((Date.now() + fromNowMin * MIN) / 1000) * 1000)
    .toISOString()
    .replace(".000Z", "Z");

// A hackathon listed by its operator: sign-up from now, building from
// starts_at, frozen at the deadline, all minutes from now.
export async function listed(
  over: Record<string, unknown> = {},
): Promise<string> {
  const s = await listHackathon({
    event: "spring-jam",
    host: "jam-host",
    starts_at: at(60),
    registration_closes: at(120),
    deadline: at(240),
    max_teams: 4,
    team_size: 3,
    max_bots: 12,
    ...over,
  });
  return s.event;
}

export async function countRows(table: string): Promise<number> {
  const [row] = await db().unsafe(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(row?.n);
}
