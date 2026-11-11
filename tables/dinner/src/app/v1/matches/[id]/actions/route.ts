import {
  assertWritable,
  consume,
  json,
  readJson,
} from "@unprompted-tables/server";
import { z } from "zod";
import { route } from "@/lib/http";
import { moveRules } from "@/lib/limits";
import { act, fold, view } from "@/lib/rules";
import { authenticate } from "@/lib/sessions";
import { withMatch } from "@/lib/store";
import { markRead } from "@/lib/wake";

// Every move either game takes; each match's own rules refuse the moves
// that aren't part of its game.
const schema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("talk"),
    // The game refuses hidden characters with invalid_text.
    text: z.string().min(1).max(4000),
    // Executives whose assistants alone should read it.
    to: z.array(z.string().max(20)).max(10).optional(),
  }),
  z.strictObject({
    kind: z.literal("propose"),
    round: z.number().int().min(1).max(100).optional(),
    seating: z.array(z.string().max(20)).min(1).max(20),
  }),
  z.strictObject({
    kind: z.literal("motion"),
    seating: z.array(z.string().max(20)).min(1).max(20),
  }),
  // The open floor votes on a motion; the three-round game, on a round.
  z.strictObject({
    kind: z.literal("vote"),
    motion: z.number().int().min(1).max(1000).optional(),
    round: z.number().int().min(1).max(100).optional(),
    ballot: z.enum(["yes", "no"]),
  }),
  z.strictObject({
    kind: z.literal("name"),
    executive: z.string().max(20),
    dislikes: z.string().max(20),
  }),
  z.strictObject({
    kind: z.literal("back"),
    proposal: z
      .string()
      .regex(/^P[0-9]{1,4}$/)
      .nullable(),
  }),
]);

export const POST = route(
  async (req, ctx: { params: Promise<{ id: string }> }) => {
    const player = await authenticate(req);
    assertWritable();
    const action = await readJson(req, schema);
    return json(
      await withMatch(
        (await ctx.params).id,
        async (state, history, tx, at) => {
          await consume(tx, moveRules(player));
          // The answer shows the match, so the actor has read it.
          await markRead(state.id, player, tx);
          const events = act(state, player, action, at);
          return {
            events,
            value: view(fold(state, events), [...history, ...events], player, {
              now: at,
            }),
          };
        },
        player,
      ),
    );
  },
);
