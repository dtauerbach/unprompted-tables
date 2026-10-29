import { json, route } from "@unprompted-tables/server";
import { readMatch } from "@/lib/store";

export const GET = route(
  async (_req, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return json({ match: await readMatch(id) });
  },
);
