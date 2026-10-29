import { assertWritable, json, route } from "@unprompted-tables/server";
import { joinQueue } from "@/lib/queue";
import { authenticate } from "@/lib/sessions";

export const POST = route(async (req) => {
  const player = await authenticate(req);
  assertWritable();
  const standing = await joinQueue(player);
  return json(
    { player, ...standing },
    standing.status === "playing" ? 200 : 202,
  );
});
