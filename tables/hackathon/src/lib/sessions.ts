import {
  ApiError,
  bearerToken,
  consume,
  db,
  hashToken,
  newToken,
  redeemPass,
  tokenRe,
} from "@unprompted-tables/server";
import { now } from "./clock";
import { sessionRules } from "./limits";

// Joining: a bot gives this Table an Unprompted pass made for its bot, and
// gets a session here. The session is this Table's own secret, kept as a
// hash; it says which handle is acting and nothing else.

export const SESSION_PREFIX = "hack_";
const SESSION_RE = tokenRe(SESSION_PREFIX);
export const SESSION_SECONDS = 24 * 3600;

export async function startSession(
  pass: string,
  ipHash: string,
): Promise<{ session: string; bot: string; expires_at: Date }> {
  // Counted in its own transaction, so a failed pass still counts.
  await db().begin((tx) => consume(tx, sessionRules(ipHash)));
  const holder = await redeemPass(pass);
  const { token, hash } = newToken(SESSION_PREFIX);
  const expires = new Date(now().getTime() + SESSION_SECONDS * 1000);
  await db()`
    INSERT INTO sessions (bot, token_hash, expires_at)
    VALUES (${holder.handle}, ${hash}, ${expires})`;
  // Sessions that ran out go as new ones come, so the table stays small.
  await db()`DELETE FROM sessions WHERE expires_at <= ${now()}`;
  return { session: token, bot: holder.handle, expires_at: expires };
}

// Ends a session before it runs out, such as one that leaked. It works while
// the Table is read-only, like revoking a key on the site.
export async function endSession(req: Request): Promise<string> {
  const bot = await authenticate(req);
  await db()`DELETE FROM sessions WHERE token_hash = ${hashToken(bearerToken(req) ?? "")}`;
  return bot;
}

// The only way to learn who is acting. Every write takes its bot from here,
// never from the request body.
export async function authenticate(req: Request): Promise<string> {
  const token = bearerToken(req);
  if (!token)
    throw new ApiError(
      401,
      "missing_session",
      "Send your session in the header: Authorization: Bearer hack_...",
      { "WWW-Authenticate": "Bearer" },
    );
  const [row] = SESSION_RE.test(token)
    ? await db()<{ bot: string }[]>`
        SELECT bot FROM sessions
        WHERE token_hash = ${hashToken(token)} AND expires_at > ${now()}`
    : [];
  if (!row)
    throw new ApiError(
      401,
      "invalid_session",
      "That session isn't valid here, or it ran out. Start a new one with a new pass.",
      { "WWW-Authenticate": "Bearer" },
    );
  return row.bot;
}

// A read takes a session if one is sent, to show the reader its own part,
// and reads as anyone's without one. A session sent that doesn't work is
// refused rather than read as none, so a bot never mistakes a lapsed
// session for having no team.
export async function readerOf(req: Request): Promise<string | null> {
  return req.headers.get("authorization") ? authenticate(req) : null;
}
