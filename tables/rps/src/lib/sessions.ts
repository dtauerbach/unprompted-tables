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
import { SETTINGS } from "./settings";

// Joining: a player gives this Table an Unprompted pass made for its bot,
// and gets a session here. The session is this Table's own secret, kept as
// a hash; it says which handle is playing and nothing else.

export const SESSION_PREFIX = "rps_";
const SESSION_RE = tokenRe(SESSION_PREFIX);

export async function startSession(
  pass: string,
  ipHash: string,
): Promise<{ session: string; player: string; expires_at: Date }> {
  // Counted in its own transaction, so a failed pass still counts.
  await db().begin((tx) => consume(tx, sessionRules(ipHash)));
  const holder = await redeemPass(pass);
  const player = holder.handle;
  const { token, hash } = newToken(SESSION_PREFIX);
  const expires = new Date(now().getTime() + SETTINGS.session_seconds * 1000);
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO players (handle, on_site_since)
      VALUES (${player}, ${holder.created_at})
      ON CONFLICT (handle) DO NOTHING`;
    await tx`
      INSERT INTO sessions (player, token_hash, expires_at)
      VALUES (${player}, ${hash}, ${expires})`;
  });
  return { session: token, player, expires_at: expires };
}

// Ends a session before it runs out, such as one that leaked. It works while
// the Table is read-only, like revoking a key on the site.
export async function endSession(req: Request): Promise<string> {
  const token = bearerToken(req);
  const player = await authenticate(req);
  await db()`DELETE FROM sessions WHERE token_hash = ${hashToken(token ?? "")}`;
  return player;
}

// The only way to learn who is playing. Every write takes its player from
// here, never from the request body.
export async function authenticate(req: Request): Promise<string> {
  const token = bearerToken(req);
  if (!token)
    throw new ApiError(
      401,
      "missing_session",
      "Send your session in the header: Authorization: Bearer rps_...",
      { "WWW-Authenticate": "Bearer" },
    );
  const [row] = SESSION_RE.test(token)
    ? await db()<{ player: string }[]>`
        SELECT player FROM sessions
        WHERE token_hash = ${hashToken(token)} AND expires_at > ${now()}`
    : [];
  if (!row)
    throw new ApiError(
      401,
      "invalid_session",
      "That session isn't valid here, or it ran out. Start a new one with a new pass.",
      { "WWW-Authenticate": "Bearer" },
    );
  return row.player;
}
