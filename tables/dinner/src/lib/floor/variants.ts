import { LIMITS } from "@unprompted-tables/spectator";
import { z } from "zod";

// The open floor's variants (rules_version 3). A variant names a level of
// conflict, which sets how deals are drawn (generate.ts) and stays private
// until the end, and sets the public rules: when the floor opens, how long
// a vote stays open, the window dinner is served in, and the limits. Each
// match records what it was dealt under, so changing a variant never
// changes a match already played.

export const LEVELS = ["simmer", "feud", "knives"] as const;
export type Level = (typeof LEVELS)[number];

const int = (min: number, max: number) => z.number().int().min(min).max(max);

// Room left under a timeline entry's text limit. It once held a
// "(Private, to …) " mark in the text; recipients now ride in `to`, and the
// limit stays where it was so every variant keeps its bounds.
export const MAX_MESSAGE_CHARS = LIMITS.text - 200;

// What the feed of a whole match could weigh at most, as UTF-8 JSON: every
// message at full length in a script that takes three bytes a character,
// each marked private with every recipient named, every motion with its
// ballots and result, and every reveal at its limit. Kept generous; a test
// plays a match at its worst and checks this is never under.
const ENTRY = 120;
// A private message's `to`: four recipient ids and their JSON.
const PRIVATE_MARK = 120;
// A motion's three entries: moved, its ballots, its result.
const MOTION = 3 * (400 + ENTRY);
// Five executives, the guesses, the end, the theory, and the votes, which
// split into as many reveals as they need.
export const MAX_REVEALS = 16;
export function floorFeedBytes(v: {
  motions_per_assistant: number;
  messages_per_assistant: number;
  message_chars: number;
}): number {
  const talk =
    5 * v.messages_per_assistant * (3 * v.message_chars + PRIVATE_MARK + ENTRY);
  return (
    talk +
    5 * v.motions_per_assistant * MOTION +
    MAX_REVEALS * 3 * LIMITS.reveal +
    11 * 6 * LIMITS.label +
    20_000
  );
}

// Every entry a full match puts on the timeline: each message, each
// motion's three, the opening and the end.
export function floorTimeline(v: {
  motions_per_assistant: number;
  messages_per_assistant: number;
}): number {
  return 5 * v.messages_per_assistant + 15 * v.motions_per_assistant + 2;
}

export const floorVariantSchema = z
  .strictObject({
    game: z.literal("floor"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    level: z.enum(LEVELS),
    // Talk only until then: seconds after the start.
    floor_opens: int(0, 3600),
    // How long a vote stays open after its motion, at most.
    vote_seconds: int(5, 3600),
    // Dinner is served at a moment drawn from the seed, uniformly over
    // these seconds after the start in these steps. The window is public;
    // the moment is not, until it comes.
    served: z
      .strictObject({
        from: int(30, 86_400),
        to: int(30, 86_400),
        step: int(1, 3600),
      })
      .refine((w) => w.to >= w.from && (w.to - w.from) % w.step === 0, {
        message: "the window must run forward in whole steps",
      }),
    motions_per_assistant: int(1, 10),
    // Open and private messages together, per assistant.
    messages_per_assistant: int(1, 200),
    message_chars: int(50, MAX_MESSAGE_CHARS),
    // No standing seating at dinner: each executive's worst minus this.
    no_deal_margin: int(1, 100),
    // A sealed guess "X dislikes Y": right earns the namer `right`, wrong
    // costs `wrong`, and an executive named rightly by anyone takes
    // `exposed`, once. Every dealt variant scores guesses at zero: the
    // public likes leave each secret one of two names, and a guess from
    // the card alone is right most of the time (README, "Naming").
    naming: z.strictObject({
      right: int(0, 20),
      wrong: int(-20, 0),
      exposed: int(-20, 0),
    }),
  })
  .refine((v) => v.floor_opens < v.served.from, {
    message: "the floor must open before dinner can be served",
  })
  .refine((v) => floorTimeline(v) <= LIMITS.timeline, {
    message: "a full match's moves wouldn't all fit what watchers see",
  })
  .refine((v) => floorFeedBytes(v) <= LIMITS.bytes, {
    message: "a full match's feed would be too big for watchers",
  });
export type FloorVariant = z.infer<typeof floorVariantSchema>;

function variant(level: Level, name: string = level): FloorVariant {
  return {
    game: "floor",
    name,
    level,
    floor_opens: 180,
    vote_seconds: 120,
    // Any whole second: on a coarser grid, a match still unserved one
    // step before the end would give the end away.
    served: { from: 1500, to: 1860, step: 1 },
    motions_per_assistant: 3,
    messages_per_assistant: 40,
    message_chars: 600,
    no_deal_margin: 3,
    naming: { right: 0, wrong: 0, exposed: 0 },
  };
}

// Only the levels that have been played in tests can be dealt. simmer and
// knives keep their generator (generate.ts) and its tests, and become
// variants here once they've been played.
export const FLOOR_VARIANTS: Record<string, FloorVariant> = {
  feud: variant("feud"),
  // For scripted evals and tests: a feud with short clocks. The floor
  // opens after 10 seconds, a vote runs 30, and dinner comes between a
  // minute and a half and two minutes in.
  "quick-feud": {
    ...variant("feud", "quick-feud"),
    floor_opens: 10,
    vote_seconds: 30,
    served: { from: 90, to: 120, step: 1 },
  },
};

for (const v of Object.values(FLOOR_VARIANTS)) floorVariantSchema.parse(v);

export const DEFAULT_VARIANT = "feud";

// Whether guesses change anyone's points under these rules.
export const namingScores = (r: {
  naming: { right: number; wrong: number; exposed: number };
}) => r.naming.right !== 0 || r.naming.wrong !== 0 || r.naming.exposed !== 0;
