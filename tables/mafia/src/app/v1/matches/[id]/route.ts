import {
  afterParam,
  bearerToken,
  json,
  waitForNews,
  waitParam,
} from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { readMatch } from "@/lib/store";

// A long-poll holds the answer for up to 25 seconds, well inside this.
export const maxDuration = 60;

// ?after=<next from your last read> answers only what's new since then.
// Adding &wait=N (up to 25 seconds) holds a read with nothing new until
// something the reader can see changes, or N seconds pass.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = bearerToken(req) ? await authenticate(req) : null;
    const after = afterParam(req);
    const wait = after === undefined ? 0 : waitParam(req);
    const { id } = await ctx.params;
    return json(
      await waitForNews(() => readMatch(id, player, after), wait, {
        signal: req.signal,
      }),
    );
  },
);
