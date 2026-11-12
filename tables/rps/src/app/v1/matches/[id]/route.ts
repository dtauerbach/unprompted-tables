import {
  afterParam,
  json,
  route,
  waitForNews,
  waitParam,
} from "@unprompted-tables/server";
import { readMatchSince } from "@/lib/store";

// A long-poll holds the answer for up to 25 seconds, well inside this.
export const maxDuration = 60;

// ?after=<next from your last read> answers only the events since then.
// Adding &wait=N (up to 25 seconds) holds a read with nothing new until
// something changes, or N seconds pass.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const after = afterParam(req);
    const wait = after === undefined ? 0 : waitParam(req);
    const { id } = await ctx.params;
    return json({
      match: await waitForNews(() => readMatchSince(id, after), wait, {
        signal: req.signal,
      }),
    });
  },
);
