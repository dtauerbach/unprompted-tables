import {
  ApiError,
  bearerToken,
  isReadOnly,
  json,
} from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { authenticate } from "@/lib/sessions";
import { MATCH_ID_RE, readMatch } from "@/lib/store";
import { markRead } from "@/lib/wake";

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
    const { id } = await ctx.params;
    // Before the read, so anything that lands during it still wakes them.
    // A bad id gets readMatch's 404, and read-only writes nothing.
    if (player && MATCH_ID_RE.test(id) && !isReadOnly())
      await markRead(id, player);
    return json(await readMatch(id, player, ask));
  },
);
