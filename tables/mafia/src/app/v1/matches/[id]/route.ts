import {
  afterParam,
  bearerToken,
  json,
  probeMatch,
  waitForNews,
  waitParam,
} from "@unprompted-tables/server";
import { now } from "@/lib/clock";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { GAME } from "@/lib/settings";
import { readMatch } from "@/lib/store";

// A long-poll holds the answer for up to 25 seconds, well inside this.
export const maxDuration = 60;

// ?after=<next from your last read> answers only what's new since then.
// Adding &wait=N (up to 25 seconds), as a player in the match, holds a
// read with nothing new until something the reader can see changes, or N
// seconds pass.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = bearerToken(req) ? await authenticate(req) : null;
    const after = afterParam(req);
    const asked = waitParam(req);
    const { id } = await ctx.params;
    return json(
      await waitForNews(
        () => readMatch(id, player, after),
        after === undefined ? 0 : asked,
        {
          seated: (a) => a.you !== null,
          probe: () => probeMatch(GAME, id, () => now().getTime() - Date.now()),
          reader: `${GAME}\n${id}\n${player ?? ""}`,
          signal: req.signal,
        },
      ),
    );
  },
);
