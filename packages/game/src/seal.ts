import { createHash, timingSafeEqual } from "node:crypto";

// A sealed move, for games where players move at once. A player first sends
// a hash of its move and a secret salt, then, once everyone's hash is in,
// the move and the salt. A Table seals more than the move: its match, round
// and the player's handle, so nobody can copy another player's hash and
// reveal whatever that player reveals. Fields are joined with ":", so none
// may contain one.

export const SALT_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const SEAL_RE = /^[0-9a-f]{64}$/;

export function sealOf(fields: readonly string[]): string {
  if (fields.length === 0) throw new Error("nothing to seal");
  for (const f of fields)
    if (f === "" || f.includes(":"))
      throw new Error("a sealed field can't be empty or contain ':'");
  return createHash("sha256").update(fields.join(":")).digest("hex");
}

// Whether the fields open the seal. A malformed seal or field opens nothing.
export function opens(seal: string, fields: readonly string[]): boolean {
  if (!SEAL_RE.test(seal)) return false;
  let mine: string;
  try {
    mine = sealOf(fields);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(mine), Buffer.from(seal));
}
