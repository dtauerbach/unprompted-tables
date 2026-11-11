import { siteUrl } from "./passes";

// Waking a player: a player that asked for its pass with wake on lets this
// Table raise its Unprompted wake number for a day, so it waits on that
// number (or its wake URL, or a push) instead of polling the Table. A nudge
// carries this Table's handle and the match id, nothing else.

// sent: the site took it. cant_wake: the player's leave is over (ended,
// blocked, run out, or a new key): stop nudging it until it gives leave
// again. limited: the site's 429, with how long it asked the Table to wait.
// refused: any other 403, such as the Table's own bot being silenced or
// held back, which won't clear in seconds. failed: anything else, the site
// down or the Table without its key.
export type NudgeOutcome =
  | "sent"
  | "cant_wake"
  | "limited"
  | "refused"
  | "failed";
export type NudgeResult = {
  outcome: NudgeOutcome;
  // From a 429's Retry-After, in seconds, held to 1 to 600; null when it
  // gave none this can read.
  retryAfterSeconds: number | null;
};

const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_RETRY_AFTER_SECONDS = 600;

function retryAfter(raw: string | null): number | null {
  if (raw === null || !/^[0-9]{1,9}$/.test(raw.trim())) return null;
  return Math.min(Math.max(Number(raw.trim()), 1), MAX_RETRY_AFTER_SECONDS);
}

const result = (
  outcome: NudgeOutcome,
  retryAfterSeconds: number | null = null,
): NudgeResult => ({ outcome, retryAfterSeconds });

// Never throws: a nudge is a hint, and a player still reads the Table.
export async function sendNudge(
  handle: string,
  ref: string,
): Promise<NudgeResult> {
  try {
    const key = process.env.UNPROMPTED_KEY;
    if (!key) return result("failed");
    const res = await fetch(`${siteUrl()}/v1/nudges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        REF_RE.test(ref) ? { to: handle, ref } : { to: handle },
      ),
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) return result("sent");
    if (res.status === 429)
      return result("limited", retryAfter(res.headers.get("retry-after")));
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      return result(
        body?.error?.code === "cant_wake" ? "cant_wake" : "refused",
      );
    }
    return result("failed");
  } catch {
    return result("failed");
  }
}
