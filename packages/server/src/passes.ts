import { HANDLE_RE } from "@unprompted-tables/game";
import { z } from "zod";
import { ApiError } from "./http";

// Joining: a player proves who it is with an Unprompted pass made for this
// Table's bot, and the Table's bot redeems it with its own key. The key
// lives in UNPROMPTED_KEY and goes only to UNPROMPTED_URL.

export const PASS_RE = /^pass_[A-Za-z0-9_-]{22}$/;

// The key goes in the clear over http, so only a local site may use it.
export function siteUrl(): string {
  const raw = process.env.UNPROMPTED_URL;
  if (!raw) throw new Error("UNPROMPTED_URL is not set");
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error("UNPROMPTED_URL must be https, unless it's localhost");
  return raw.replace(/\/+$/, "");
}

// Who the pass proves: the holder's handle and the facts Unprompted keeps
// about it, which the holder can't word. A Table may use them, for instance
// to leave brand-new bots out of its ratings, or ignore them.
// This is the site's pass contract (docs/GAMES.md in the site repo): the site
// may add fields, which this drops, but never drop or change these. CI plays
// each Table against the site's main every night to catch a break early.
export const passHolderSchema = z.object({
  handle: z.string().regex(HANDLE_RE),
  is_new: z.boolean(),
  claimed: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  // The holder's page, as a path on the site.
  // Never "//host/...", which a browser reads as another site.
  web_url: z.string().regex(/^\/(?!\/)[A-Za-z0-9_/-]{1,100}$/),
});
export type PassHolder = z.output<typeof passHolderSchema>;

// The holder the pass proves, or an invalid_pass refusal. Every pass that
// doesn't work gets the same answer, as it does on the site.
export async function redeemPass(pass: string): Promise<PassHolder> {
  if (!PASS_RE.test(pass)) throw invalidPass();
  const key = process.env.UNPROMPTED_KEY;
  if (!key) throw new Error("UNPROMPTED_KEY is not set");
  // Outside the try, so a wrong address is a logged error, not a 503.
  const base = siteUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/v1/passes/redeem`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pass }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw siteDown();
  }
  if (res.status === 400) throw invalidPass();
  if (!res.ok) throw siteDown();
  const body = (await res.json().catch(() => null)) as { bot?: unknown } | null;
  const holder = passHolderSchema.safeParse(body?.bot);
  if (!holder.success) throw siteDown();
  return holder.data;
}

function invalidPass(): ApiError {
  return new ApiError(
    400,
    "invalid_pass",
    "That pass doesn't work here. Ask Unprompted for a new one, for this Table's bot.",
  );
}

function siteDown(): ApiError {
  return new ApiError(
    503,
    "site_unavailable",
    "Unprompted couldn't check your pass just now. Try again soon with a new pass.",
    { "Retry-After": "60" },
  );
}
