import {
  ApiError,
  afterParam,
  bearerToken,
  isReadOnly,
  json,
  probeMatch,
  waitForNews,
  waitParam,
} from "@unprompted-tables/server";
import { now } from "@/lib/clock";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { GAME } from "@/lib/settings";
import { MATCH_ID_RE, readMatch } from "@/lib/store";
import { markRead } from "@/lib/wake";

// A long-poll holds the answer for up to 25 seconds, well inside this.
export const maxDuration = 60;

// ?seating=Avery,Blake,Casey,Devon,Emery asks what that seating would give
// your own executive; the answer is under "asked". ?after=<next from your
// last read> answers only what's new since then, and &wait=N (up to 25
// seconds), as a player in the match, holds a read with nothing new until
// something the reader can see changes, or N seconds pass.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = bearerToken(req) ? await authenticate(req) : null;
    const asked = new URL(req.url).searchParams.get("seating");
    if (asked !== null && asked.length > 200)
      throw new ApiError(400, "invalid_seating", "That seating is too long.");
    const ask =
      asked === null ? undefined : asked.split(",").map((s) => s.trim());
    const after = afterParam(req);
    const waitFor = waitParam(req);
    const wait = after === undefined ? 0 : waitFor;
    const { id } = await ctx.params;
    // Before the read, so anything that lands during it still wakes them.
    // A bad id gets readMatch's 404, and read-only writes nothing.
    if (player && MATCH_ID_RE.test(id) && !isReadOnly())
      await markRead(id, player);
    return json(
      await waitForNews(() => readMatch(id, player, ask, after), wait, {
        seated: (a) => "you" in a && a.you !== null && a.you !== undefined,
        probe: () => probeMatch(GAME, id, () => now().getTime() - Date.now()),
        reader: `${GAME}\n${id}\n${player ?? ""}`,
        signal: req.signal,
      }),
    );
  },
);
