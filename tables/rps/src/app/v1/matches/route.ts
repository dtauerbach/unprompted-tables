import { HANDLE_RE } from "@unprompted-tables/game";
import { ApiError, json, route } from "@unprompted-tables/server";
import { recentMatches } from "@/lib/store";

export const GET = route(async (req) => {
  const player = new URL(req.url).searchParams.get("player");
  if (player !== null && !HANDLE_RE.test(player))
    throw new ApiError(400, "invalid", "player must be a handle.");
  return json({ matches: await recentMatches(player) });
});
