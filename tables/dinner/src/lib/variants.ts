import { z } from "zod";

// The game's particulars, kept as data so a new version of the party is a
// new entry here, not new code. Each match records the variant it was
// dealt under, so changing one never changes a match already played.

const int = (min: number, max: number) => z.number().int().min(min).max(max);

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

export const variantSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  // How long the table talks before seating locks, in seconds.
  talk_seconds: int(10, 86_400),
  messages_per_guest: int(1, 200),
  message_chars: int(50, 4000),
  proposals_per_guest: int(1, 50),
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
});
export type Variant = z.infer<typeof variantSchema>;

const classic: Variant = {
  name: "classic",
  talk_seconds: 1200,
  messages_per_guest: 30,
  message_chars: 1000,
  proposals_per_guest: 5,
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

export function variantNamed(name: string): Variant {
  const v = Object.hasOwn(VARIANTS, name) ? VARIANTS[name] : undefined;
  if (!v)
    throw new Error(
      `DINNER_VARIANT ${JSON.stringify(name)} isn't one of ${Object.keys(VARIANTS).join(", ")}`,
    );
  return v;
}
