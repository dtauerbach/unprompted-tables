import { LIMITS } from "@unprompted-tables/spectator";
import { z } from "zod";
import { type ExecVariant, execVariantSchema } from "./exec/variants";
import {
  DEFAULT_VARIANT,
  FLOOR_VARIANTS,
  type FloorVariant,
  floorVariantSchema,
} from "./floor/variants";

// The game's particulars, kept as data so a new version of the party is a
// new entry here, not new code. Each match records the variant it was
// dealt under, so changing one never changes a match already played.

// How many guests a party can seat.
export const GUESTS = { min: 4, max: 9 } as const;

const int = (min: number, max: number) => z.number().int().min(min).max(max);

// The most a full party's feed could weigh, as UTF-8 JSON: every guest's
// talk at full length in a script that takes three bytes a character (the
// most any character a feed keeps can take, escaped), every proposal and
// change of backing, and each brief revealed at the end. Kept generous; a
// test plays a full party at its worst and checks this is never under.
const ENTRY = 120; // an entry's other fields
const ACTION = 200; // a proposal's or a backing's words, names included
const PER_GUEST = 3 * LIMITS.reveal + 6 * LIMITS.label + 600;
export function feedBytes(v: {
  messages_per_guest: number;
  message_chars: number;
  proposals_per_guest: number;
  backs_per_guest: number;
}): number {
  const talk = v.messages_per_guest * (3 * v.message_chars + ENTRY);
  const moves = (v.proposals_per_guest + v.backs_per_guest) * (ACTION + ENTRY);
  return GUESTS.max * (talk + moves + PER_GUEST) + 20_000;
}

export const FALLBACKS = [
  // The plan with the most backers, if exactly one has the most.
  "most_backed",
  // The host seats everyone by the true briefs, for the worst-off guest.
  "fairest",
  // The host seats everyone by the true briefs, for the biggest total.
  "best_total",
  // Seats drawn at random. Always works, so it ends a chain.
  "random",
] as const;
export type Fallback = (typeof FALLBACKS)[number];

export const variantSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    // How long the table talks before seating locks, in seconds.
    talk_seconds: int(10, 86_400),
    messages_per_guest: int(1, 200),
    message_chars: int(50, 4000),
    proposals_per_guest: int(1, 50),
    // Changes of backing, so flipping back and forth can't crowd the talk
    // out of what watchers see.
    backs_per_guest: int(1, 200),
    brief: z.strictObject({
      // Guests each one would love to sit beside.
      favorites: int(0, 3),
      // Guests each one wants kept away.
      avoids: int(0, 3),
      // Guests most others want to sit by, so they're fought over.
      stars: int(0, 3),
      // Some avoids come with "don't say why".
      secret_avoids: z.boolean(),
      // At least one guest loves someone who wants them kept away.
      unrequited: z.boolean(),
      // A line of character for each guest, for colour.
      personas: z.boolean(),
      love: int(1, 10),
      avoid: int(-10, -1),
      // Everyone else is liked or disliked a little, from -mild to mild.
      mild: int(0, 3),
    }),
    // Deal again until no seating gives every guest their best.
    require_conflict: z.boolean(),
    lock: z.strictObject({
      // Who must back one plan for seating to lock before the deadline.
      consensus: z.enum(["all", "majority"]),
      // Tried in order at the deadline; the first that gives a seating wins.
      fallback: z
        .array(z.enum(FALLBACKS))
        .min(1)
        .max(4)
        .refine((f) => f.at(-1) !== "most_backed", {
          message: "most_backed can't come last: it may find no single plan",
        }),
    }),
  })
  // Every guest's talk, proposals and changes of backing, with the opening
  // and the close, must fit what watchers see, or the first talk drops out.
  .refine(
    (v) =>
      GUESTS.max *
        (v.messages_per_guest + v.proposals_per_guest + v.backs_per_guest) +
        2 <=
      LIMITS.timeline,
    { message: "a full party's moves wouldn't all fit what watchers see" },
  )
  // Nor may the feed outgrow what Unprompted takes, or no one sees the party.
  .refine((v) => feedBytes(v) <= LIMITS.bytes, {
    message: "a full party's feed would be too big for watchers",
  });
export type Variant = z.infer<typeof variantSchema>;

const classic: Variant = {
  name: "classic",
  talk_seconds: 1200,
  messages_per_guest: 30,
  message_chars: 1000,
  proposals_per_guest: 5,
  backs_per_guest: 20,
  brief: {
    favorites: 2,
    avoids: 1,
    stars: 1,
    secret_avoids: true,
    unrequited: true,
    personas: true,
    love: 3,
    avoid: -3,
    mild: 1,
  },
  require_conflict: true,
  lock: { consensus: "all", fallback: ["most_backed", "random"] },
};

// The first game's variants, deprecated: still selectable by DINNER_VARIANT
// for now, never the default. New matches are the open floor
// (floor/variants.ts).
export const VARIANTS: Record<string, Variant> = {
  classic,
  // A short party for tests and quick runs.
  quick: { ...classic, name: "quick", talk_seconds: 120 },
  // No agreement falls to a host who seats everyone fairly by the briefs,
  // so holding out costs less than under classic's random draw.
  "kind-host": {
    ...classic,
    name: "kind-host",
    lock: { consensus: "all", fallback: ["most_backed", "fairest"] },
  },
  // A majority is enough, and grudges run deeper.
  majority: {
    ...classic,
    name: "majority",
    brief: { ...classic.brief, avoids: 2, avoid: -5 },
    lock: { consensus: "majority", fallback: ["most_backed", "random"] },
  },
};

for (const v of Object.values(VARIANTS)) variantSchema.parse(v);

// A match keeps the variant it was dealt under, so the three-round
// executive game's still replay; new matches can't be dealt under one.
export type AnyVariant = Variant | ExecVariant | FloorVariant;

export function isExecVariant(v: AnyVariant): v is ExecVariant {
  return "game" in v && v.game === "exec";
}

export function isFloorVariant(v: AnyVariant): v is FloorVariant {
  return "game" in v && v.game === "floor";
}

export function variantNamed(name: string = DEFAULT_VARIANT): AnyVariant {
  const v = Object.hasOwn(FLOOR_VARIANTS, name)
    ? FLOOR_VARIANTS[name]
    : Object.hasOwn(VARIANTS, name)
      ? VARIANTS[name]
      : undefined;
  if (!v)
    throw new Error(
      `DINNER_VARIANT ${JSON.stringify(name)} isn't one of ${[...Object.keys(FLOOR_VARIANTS), ...Object.keys(VARIANTS)].join(", ")}`,
    );
  return v;
}

export function parseVariant(v: AnyVariant): AnyVariant {
  if (isFloorVariant(v)) return floorVariantSchema.parse(v);
  return isExecVariant(v) ? execVariantSchema.parse(v) : variantSchema.parse(v);
}
