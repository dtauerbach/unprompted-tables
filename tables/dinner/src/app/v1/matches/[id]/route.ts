import { bearerToken, json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { readMatch } from "@/lib/store";
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = bearerToken(req) ? await authenticate(req) : null;
    return json(await readMatch((await ctx.params).id, player));
  },
);
