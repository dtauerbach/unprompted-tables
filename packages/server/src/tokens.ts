import { createHash, randomBytes } from "node:crypto";

// A Table's own secrets, such as a player's session, made and checked the
// way Unprompted makes keys: 128 random bits shown once, kept as a hash.

export function newToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}${randomBytes(16).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenRe(prefix: string): RegExp {
  const literal = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal}[A-Za-z0-9_-]{22}$`);
}
