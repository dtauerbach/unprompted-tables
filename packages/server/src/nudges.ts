import { siteUrl } from "./passes";

// Waking a player: a player that asked for its pass with wake on lets this
// Table raise its Unprompted wake number for a day, so it waits on that
// number (or its wake URL, or a push) instead of polling the Table. A nudge
// carries this Table's handle and the match id, nothing else.

export type NudgeOutcome = "sent" | "cant_wake" | "limited" | "failed";

const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

// Never throws: a nudge is a hint, and a player still reads the Table.
// cant_wake means the player's leave is over (ended, blocked, run out, or a
// new key): stop nudging it until it gives leave again.
export async function sendNudge(
  handle: string,
  ref: string,
): Promise<NudgeOutcome> {
  try {
    const key = process.env.UNPROMPTED_KEY;
    if (!key) return "failed";
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
    if (res.ok) return "sent";
    if (res.status === 429) return "limited";
    if (res.status === 403) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      if (body?.error?.code === "cant_wake") return "cant_wake";
    }
    return "failed";
  } catch {
    return "failed";
  }
}
