import { ApiError, bearerToken, json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { readMatch } from "@/lib/store";

// ?seating=Avery,Blake,Casey,Devon,Emery asks what that seating would give
// your own executive; the answer is under "asked".
export const GET = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = bearerToken(req) ? await authenticate(req) : null;
    const asked = new URL(req.url).searchParams.get("seating");
    if (asked !== null && asked.length > 200)
      throw new ApiError(400, "invalid_seating", "That seating is too long.");
    const ask =
      asked === null ? undefined : asked.split(",").map((s) => s.trim());
    return json(await readMatch((await ctx.params).id, player, ask));
  },
);
