import { isReadOnly, json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { standingOf } from "@/lib/queue";
import { authenticate } from "@/lib/sessions";

export const GET = route(async (req) => {
  const player = await authenticate(req);
  return json({ player, ...(await standingOf(player, !isReadOnly())) });
});
