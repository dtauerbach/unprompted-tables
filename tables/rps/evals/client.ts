import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// The harness talks to Unprompted and to this Table only over HTTP, the way
// a stranger's bot would. Nothing here imports from src/.

const trim = (u: string) => u.replace(/\/+$/, "");
export const SITE = trim(process.env.EVAL_SITE_URL ?? "http://localhost:3000");
export const TABLE = trim(
  process.env.EVAL_TABLE_URL ?? "http://localhost:3001",
);

// The site lets a local harness set X-Real-IP, so it can sign up several
// bots. Against anything else these evals would write real rows.
for (const url of [SITE, TABLE]) {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1")
    throw new Error(
      `${url} isn't local. These evals run only on this machine.`,
    );
}

const OUT_DIR = path.join(
  process.cwd(),
  "evals/out",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
mkdirSync(OUT_DIR, { recursive: true });
const TRANSCRIPT = path.join(OUT_DIR, "http.jsonl");

// Keys, passes and sessions never reach the transcript: by field, and by
// shape anywhere else.
const SHAPES = [
  /unp_[A-Za-z0-9_-]{43}/g,
  /pass_[A-Za-z0-9_-]{22}/g,
  /rps_[A-Za-z0-9_-]{22}/g,
];
const SECRET_FIELDS = new Set(["api_key", "pass", "session"]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_FIELDS.has(k) ? "[redacted]" : redact(v),
      ]),
    );
  if (typeof value === "string")
    return SHAPES.reduce((s, re) => s.replace(re, "[redacted]"), value);
  return value;
}

export type Res = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: evals read arbitrary JSON
  json: any;
};

let ip = 0;
export function freshIp(): string {
  ip += 1;
  return `10.${77 + Math.floor(Math.random() * 100)}.${(ip >> 8) & 255}.${ip & 255}`;
}

export async function send(
  url: string,
  opts: { body?: unknown; token?: string; ip?: string; method?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { "x-real-ip": opts.ip ?? freshIp() };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const started = Date.now();
  const res = await fetch(url, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  appendFileSync(
    TRANSCRIPT,
    `${JSON.stringify(
      redact({
        at: new Date().toISOString(),
        ms: Date.now() - started,
        method: opts.method,
        url,
        keyed: Boolean(opts.token),
        request: opts.body,
        status: res.status,
        response: json ?? text.slice(0, 500),
      }),
    )}\n`,
  );
  return { status: res.status, json };
}
