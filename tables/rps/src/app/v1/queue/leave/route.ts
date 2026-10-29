import { assertWritable, json, route } from "@unprompted-tables/server";
import { leaveQueue, standingOf } from "@/lib/queue";
import { authenticate } from "@/lib/sessions";

export const POST = route(async (req) => {
  const player = await authenticate(req);
  assertWritable();
  await leaveQueue(player);
  // Leaving the queue doesn't leave a match being played.
  return json({ player, ...(await standingOf(player, true)) });
});
