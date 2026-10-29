import { createHmac } from "node:crypto";
import type { z } from "zod";

// The HTTP plumbing every Table shares, in the same shape as Unprompted's
// own: JSON errors, a size limit on bodies, and addresses kept only as
// keyed hashes.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

function errorResponse(err: ApiError): Response {
  return json(
    { error: { code: err.code, message: err.message } },
    err.status,
    err.headers,
  );
}

// A refused write leaves no row behind, so this line is its only record. It
// names the route and the error, never the body or the caller's address.
function logRefusal(req: Request, err: ApiError): void {
  if (req.method === "GET" || err.status === 429 || err.code === "read_only")
    return;
  console.warn(
    JSON.stringify({
      event: "refused",
      method: req.method,
      path: new URL(req.url).pathname.slice(0, 200),
      status: err.status,
      code: err.code,
    }),
  );
}

// Wraps a route handler so every failure becomes a JSON error and nothing
// internal (stack traces, SQL) leaks to the caller.
export function route<C>(fn: (req: Request, ctx: C) => Promise<Response>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof ApiError) {
        logRefusal(req, err);
        return errorResponse(err);
      }
      console.error(err);
      return errorResponse(
        new ApiError(500, "internal", "Something went wrong on our side."),
      );
    }
  };
}

export const MAX_BODY_BYTES = 4 * 1024;

// A Table whose moves carry text, such as a debate's, can take more.
export async function readJson<S extends z.ZodType>(
  req: Request,
  schema: S,
  { maxBytes = MAX_BODY_BYTES }: { maxBytes?: number } = {},
): Promise<z.output<S>> {
  const tooLarge = () =>
    new ApiError(
      413,
      "too_large",
      `Request body is over ${Math.floor(maxBytes / 1024)} KB.`,
    );
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw tooLarge();
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_json", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "body"}: ${i.message}`)
      .join("; ");
    throw new ApiError(400, "invalid", detail);
  }
  return parsed.data;
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

export function bearerToken(req: Request): string | undefined {
  return req.headers.get("authorization")?.match(BEARER)?.[1];
}

// Vercel sets x-real-ip and overwrites x-forwarded-for, so both are
// trustworthy there. Anywhere else they are whatever the client sent.
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return networkOf(real || forwarded || "unknown");
}

// One IPv6 holder usually gets a whole /64, so limits count the /64.
export function networkOf(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head = ""] = ip.split("%");
  const halves = head.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const fill =
    halves.length > 1
      ? Array(Math.max(0, 8 - left.length - right.length)).fill("0")
      : [];
  const groups = [...left, ...fill, ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

// Keyed so a leaked database doesn't give up addresses by brute force over
// the IPv4 space. A production server refuses to hash without the secret.
export function hashIp(ip: string): string {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("IP_HASH_SECRET is not set");
  return createHmac("sha256", secret ?? "dev-only")
    .update(ip)
    .digest("hex")
    .slice(0, 32);
}
