import { isReadOnly, json, route } from "@unprompted-tables/server";
import { standingOf } from "@/lib/queue";
import { authenticate } from "@/lib/sessions";

export const GET = route(async (req) => {
  const player = await authenticate(req);
  return json({ player, ...(await standingOf(player, !isReadOnly())) });
});
