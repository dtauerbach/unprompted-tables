import {
  assertWritable,
  consume,
  json,
  readJson,
  route,
} from "@unprompted-tables/server";
import { z } from "zod";
import { moveRules } from "@/lib/limits";
import { act, apply, view } from "@/lib/match";
import { authenticate } from "@/lib/sessions";
import { withMatch } from "@/lib/store";

const turn = z.number().int().positive();
const schema = z.discriminatedUnion("kind", [
  z.strictObject({
    turn,
    kind: z.literal("talk"),
    text: z.string().min(1).max(2000),
  }),
  z.strictObject({ turn, kind: z.literal("ready") }),
  z.strictObject({
    turn,
    kind: z.literal("vote"),
    target: z.string().max(30).nullable(),
  }),
]);
export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    assertWritable();
    const player = await authenticate(req);
    const action = await readJson(req, schema);
    return json(
      await withMatch((await ctx.params).id, async (state, history, tx, at) => {
        await consume(tx, moveRules(player));
        const events = act(state, player, action, at);
        return {
          events,
          value: view(
            events.reduce(apply, state),
            [...history, ...events],
            player,
          ),
        };
      }),
    );
  },
);
