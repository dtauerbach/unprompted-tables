import { afterParam, bearerToken, json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { readMatch } from "@/lib/store";

// ?after=<next from your last read> answers only what's new since then.
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = bearerToken(req) ? await authenticate(req) : null;
    const after = afterParam(req);
    return json(await readMatch((await ctx.params).id, player, after));
  },
);
