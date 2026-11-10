import { LIMITS } from "@unprompted-tables/spectator";
import { z } from "zod";
import { CONFIGURATIONS, type Rule } from "./configs";

// The executive seating game's variants. A variant names a configuration,
// or a weighted mix of configurations to draw one from per match (private
// until the end either way), and sets the public rules: the voting rule, the
// number of rounds, every clock, and the talk limits. Each match records
// what it was dealt under, so changing a variant never changes a match
// already played.

const int = (min: number, max: number) => z.number().int().min(min).max(max);

const clock = z
  .strictObject({
    // Earliest filing, seconds after the round opens.
    talk_min: int(0, 86_400),
    // Latest filing, seconds after the round opens.
    propose_by: int(1, 86_400),
    // How long voting stays open after the filing.
    vote_seconds: int(1, 86_400),
  })
  .refine((c) => c.propose_by > c.talk_min, {
    message: "the latest filing must come after the earliest",
  });
export type Clock = z.infer<typeof clock>;

// What the feed of a whole match could weigh at most, as UTF-8 JSON: every
// message at full length in a script that takes three bytes a character,
// each marked private with every recipient named, and each round's
// announcements, plus every reveal at its limit. Kept generous; a test plays
// a match at its worst and checks this is never under.
const ENTRY = 120;
// Room left in a timeline entry for the longest private-message mark:
// "(Private, to " plus four "X's assistant" names, and the closing ") ".
export const MAX_MESSAGE_CHARS = LIMITS.text - 200;
const PRIVATE_MARK = 120;
const ROUND = 4 * (300 + ENTRY);
// Five briefs, the theory and the yardsticks; each round has its own.
const REVEALS = (5 + 2) * 3 * LIMITS.reveal;
export function execFeedBytes(v: {
  rounds: number;
  messages_per_assistant: number;
  message_chars: number;
}): number {
  const talk =
    5 * v.messages_per_assistant * (3 * v.message_chars + PRIVATE_MARK + ENTRY);
  return (
    talk +
    v.rounds * (ROUND + 3 * LIMITS.reveal) +
    REVEALS +
    11 * 6 * LIMITS.label +
    20_000
  );
}

const configName = z.enum(Object.keys(CONFIGURATIONS) as [string, ...string[]]);

// The configurations a variant can deal, with their weights, in the
// variant's own order (the draw walks this list, so order is part of it).
export function configsOf(v: {
  config: string | { config: string; weight: number }[];
}): { id: string; weight: number }[] {
  return typeof v.config === "string"
    ? [{ id: v.config, weight: 1 }]
    : v.config.map((o) => ({ id: o.config, weight: o.weight }));
}

export const execVariantSchema = z
  .strictObject({
    game: z.literal("exec"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    // One configuration, or several with whole-number weights, one drawn
    // per match from a seed stream of its own.
    config: z.union([
      configName,
      z
        .array(z.strictObject({ config: configName, weight: int(1, 100) }))
        .min(1)
        .refine(
          (m) => new Set(m.map((o) => o.config)).size === m.length,
          "name each configuration once",
        ),
    ]),
    rule: z.enum(["unanimity", "majority"]),
    rounds: int(1, 6),
    clocks: z.strictObject({ first: clock, later: clock }),
    // Open and private messages together, per assistant.
    messages_per_assistant: int(1, 200),
    // A private message's whole feed entry, marked with its recipients,
    // must fit one timeline entry.
    message_chars: int(50, MAX_MESSAGE_CHARS),
    // No deal: every executive gets their worst possible seating minus this.
    no_deal_margin: int(1, 100),
  })
  .refine(
    (v) => configsOf(v).every(({ id }) => CONFIGURATIONS[id]?.rule === v.rule),
    { message: "every configuration must use the variant's voting rule" },
  )
  .refine(
    (v) => 5 * v.messages_per_assistant + 4 * v.rounds + 4 <= LIMITS.timeline,
    { message: "a full match's moves wouldn't all fit what watchers see" },
  )
  .refine((v) => execFeedBytes(v) <= LIMITS.bytes, {
    message: "a full match's feed would be too big for watchers",
  });
export type ExecVariant = z.infer<typeof execVariantSchema>;

// Round 1 is longer: the wishes have to be exchanged before anyone can
// propose sensibly.
const CLOCKS = {
  first: { talk_min: 180, propose_by: 420, vote_seconds: 300 },
  later: { talk_min: 60, propose_by: 240, vote_seconds: 300 },
};
const QUICK = { talk_min: 0, propose_by: 60, vote_seconds: 30 };

function variant(config: string, name = config): ExecVariant {
  return {
    game: "exec",
    name,
    config,
    rule: (CONFIGURATIONS[config] as { rule: Rule }).rule,
    rounds: 3,
    clocks: CLOCKS,
    messages_per_assistant: 40,
    message_chars: 600,
    no_deal_margin: 10,
  };
}

export const EXEC_VARIANTS: Record<string, ExecVariant> = {
  aligned: variant("aligned"),
  compromise: variant("compromise"),
  standoff: variant("standoff"),
  scramble: variant("scramble"),
  // The three unanimity configurations, one drawn per match, the standoff
  // twice as often as each of the others.
  "exec-mix": {
    ...variant("standoff", "exec-mix"),
    config: [
      { config: "aligned", weight: 1 },
      { config: "compromise", weight: 1 },
      { config: "standoff", weight: 2 },
    ],
  },
  // For scripted evals and tests: a compromise with short clocks.
  "quick-compromise": {
    ...variant("compromise", "quick-compromise"),
    clocks: { first: QUICK, later: QUICK },
  },
};

for (const v of Object.values(EXEC_VARIANTS)) execVariantSchema.parse(v);

export const DEFAULT_VARIANT = "standoff";
