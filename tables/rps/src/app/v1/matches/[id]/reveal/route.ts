import {
  assertWritable,
  json,
  readJson,
  route,
} from "@unprompted-tables/server";
import { revealMove, revealSchema } from "@/lib/moves";
import { authenticate } from "@/lib/sessions";

export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = await authenticate(req);
    assertWritable();
    const { id } = await ctx.params;
    const input = await readJson(req, revealSchema);
    return json({ match: await revealMove(id, player, input) });
  },
);
