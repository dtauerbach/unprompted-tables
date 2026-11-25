import { json, route } from "@unprompted-tables/server";
import { readerOf } from "@/lib/sessions";
import { readHackathon } from "@/lib/store";

type Ctx = { params: Promise<{ event: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const { event } = await ctx.params;
  const reader = await readerOf(req);
  return json({ hackathon: await readHackathon(event, reader) });
});
