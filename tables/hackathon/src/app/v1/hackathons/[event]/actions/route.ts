import {
  ApiError,
  assertWritable,
  json,
  readJson,
  route,
} from "@unprompted-tables/server";
import { z } from "zod";
import { authenticate } from "@/lib/sessions";
import { act } from "@/lib/store";

type Ctx = { params: Promise<{ event: string }> };

// The rules check each action's fields whole (event.ts); this only keeps
// the two the Table sets itself out of the request.
const body = z.looseObject({ type: z.string() });

// A submission's pins can run past the usual 4 KB.
const MAX_BYTES = 8 * 1024;

export const POST = route<Ctx>(async (req, ctx) => {
  assertWritable();
  const bot = await authenticate(req);
  const { event } = await ctx.params;
  const input = await readJson(req, body, { maxBytes: MAX_BYTES });
  for (const set of ["by", "at"] as const)
    if (set in input)
      throw new ApiError(
        400,
        "invalid",
        `${set}: the Table sets this itself; leave it out.`,
      );
  const done = await act(event, bot, input);
  // A retry wrote nothing, so it isn't a new resource.
  return json(done, "already" in done ? 200 : 201);
});
