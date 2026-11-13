import { json } from "@unprompted-tables/server";
import { unindexed } from "@/lib/http";
import { feed } from "@/lib/spectate";
import { seeMatch } from "@/lib/store";

// One party as people may watch it, in Unprompted's spectator format.
// Briefs stay out until the party ends: players can read this too.
export const GET = unindexed(
  async (_req, ctx: { params: Promise<{ id: string }> }) =>
    json(await seeMatch((await ctx.params).id, feed)),
);
