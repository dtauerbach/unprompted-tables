import { ApiError, json, route } from "@unprompted-tables/server";
import { COUNTS } from "@/lib/rating";
import { currentStandings } from "@/lib/standings";

export const GET = route(async (req) => {
  const raw = new URL(req.url).searchParams.get("top") ?? "100";
  const top = /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(top >= 1 && top <= 1000))
    throw new ApiError(400, "invalid", "top must be a number from 1 to 1000.");
  const { standings, records } = await currentStandings(top);
  return json({ standings, counts: COUNTS, records });
});
