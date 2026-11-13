import {
  afterParam,
  bearerToken,
  json,
  probeMatch,
  route,
  waitForNews,
  waitParam,
} from "@unprompted-tables/server";
import { now } from "@/lib/clock";
import { authenticate } from "@/lib/sessions";
import { GAME } from "@/lib/settings";
import { readMatchSince } from "@/lib/store";

// A long-poll holds the answer for up to 25 seconds, well inside this.
export const maxDuration = 60;

// ?after=<next from your last read> answers only the events since then.
// Adding &wait=N (up to 25 seconds), with the session of a player in the
// match, holds a read with nothing new until something changes, or N
// seconds pass.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const after = afterParam(req);
    const asked = waitParam(req);
    const wait = after === undefined ? 0 : asked;
    const player =
      wait > 0 && bearerToken(req) ? await authenticate(req) : null;
    const { id } = await ctx.params;
    return json({
      match: await waitForNews(() => readMatchSince(id, after), wait, {
        seated: (a) => player !== null && a.players.includes(player),
        probe: () => probeMatch(GAME, id, () => now().getTime() - Date.now()),
        reader: `${GAME}\n${id}\n${player ?? ""}`,
        signal: req.signal,
      }),
    });
  },
);
