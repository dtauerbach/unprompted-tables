import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { ApiError } from "./http";

// A read cursor: how many of a match's events one reader has been shown,
// sealed so that nobody can read the number, change it, or use it as
// another reader or on another match. The number counts only the events
// that reader can see, never the stored sequence, whose gaps would show
// how much private talk went on; sealing it as well means a player who
// pastes its cursor in the table talk gives away nothing, not even how
// many private events it has seen. A fresh nonce each time keeps two
// cursors for the same count from looking alike.

const PREFIX = "c1.";
const NONCE = 12;
const TAG = 16;
const MAX_AFTER = 200;

// A key of its own for each scope, so the random nonces of one reader's
// cursors never share a key with anyone else's, however many cursors a
// Table seals. The scope is the associated data as well.
function key(scope: string): Buffer {
  const secret = process.env.IP_HASH_SECRET;
  if (!secret && process.env.NODE_ENV === "production")
    throw new Error("IP_HASH_SECRET is not set");
  const root = createHmac("sha256", secret ?? "dev-only")
    .update("unprompted-tables read cursor v1")
    .digest();
  return createHmac("sha256", root).update(scope, "utf8").digest();
}

// Whose cursor it is: the Table, the match and the reader (a player's
// handle, or none for a reader without a seat).
export function cursorScope(
  table: string,
  match: string,
  reader: string | null,
): string {
  return `${table}\n${match}\n${reader ?? ""}`;
}

export function sealCursor(scope: string, count: number): string {
  if (!Number.isInteger(count) || count < 0 || count > 0xffffffff)
    throw new Error("cursor count out of range");
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key(scope), nonce);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const plain = Buffer.alloc(4);
  plain.writeUInt32BE(count);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return (
    PREFIX +
    Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url")
  );
}

// The count a cursor holds, or null if it isn't one this Table sealed for
// this scope: made up, changed, another reader's or another match's.
export function openCursor(scope: string, cursor: string): number | null {
  if (!cursor.startsWith(PREFIX)) return null;
  const raw = cursor.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64url");
  // Only the one spelling it was sealed with: base64's spare bits can't
  // make a second string for the same cursor.
  if (bytes.length !== NONCE + TAG + 4 || bytes.toString("base64url") !== raw)
    return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(scope),
      bytes.subarray(0, NONCE),
    );
    decipher.setAAD(Buffer.from(scope, "utf8"));
    decipher.setAuthTag(bytes.subarray(NONCE, NONCE + TAG));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(NONCE + TAG)),
      decipher.final(),
    ]);
    return plain.readUInt32BE(0);
  } catch {
    return null;
  }
}

// The `after` a read was asked with: undefined for a whole read, else the
// cursor as sent. Anything far longer than a cursor is refused outright.
export function afterParam(req: Request): string | undefined {
  const after = new URL(req.url).searchParams.get("after");
  if (after === null) return undefined;
  if (after.length > MAX_AFTER)
    throw new ApiError(
      400,
      "invalid_cursor",
      "That isn't a cursor. Use the `next` from your last read, or read without `after`.",
    );
  return after;
}
