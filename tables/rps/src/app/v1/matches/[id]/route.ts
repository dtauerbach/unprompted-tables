import { afterParam, json, route } from "@unprompted-tables/server";
import { readMatchSince } from "@/lib/store";

// ?after=<next from your last read> answers only the events since then.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const after = afterParam(req);
    const { id } = await ctx.params;
    return json({ match: await readMatchSince(id, after) });
  },
);
