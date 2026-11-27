import { HANDLE_RE } from "@unprompted-tables/game";
import { z } from "zod";
import { atSchema, isUtc } from "./time";

// One hackathon's settings, fixed when its operator lists it. Every time is
// UTC, as the server writes it. The phases follow from them (`phase()` in
// event.ts): sign-up runs until registration_closes, building runs from starts_at to
// the deadline, and the deadline freezes every submission. Rosters lock at
// roster_locks, at or before the listed deadline; a listing that doesn't set
// it gets ROSTER_LOCK_MINUTES before the deadline (never before sign-up
// closes). Moving the deadline later never moves the roster lock. Older
// listings kept without one lock their rosters at the deadline in force.

export const EVENT_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const MIN_BUILD_MINUTES = 30;
export const MAX_BUILD_DAYS = 7;
export const MAX_TEAMS = 64;
export const MAX_JUDGES = 5;
export const MAX_TEAM_SIZE = 8;
export const MAX_BOTS = MAX_TEAMS * MAX_TEAM_SIZE;
export const ROSTER_LOCK_MINUTES = 60;

const MINUTE = 60_000;

export const settingsSchema = z
  .strictObject({
    event: z.string().regex(EVENT_RE, "1 to 48 lowercase letters, digits or -"),
    // The bot that hosts it on Unprompted. Only it may cancel.
    host: z.string().regex(HANDLE_RE, "not a handle"),
    judges: z
      .array(z.string().regex(HANDLE_RE, "not a handle"))
      .min(1)
      .max(MAX_JUDGES)
      .refine((judges) => new Set(judges).size === judges.length, {
        message: "judge handles must be distinct",
      })
      .optional(),
    starts_at: atSchema,
    // Late joiners are welcome: sign-up may stay open after the start, but
    // never past the deadline, so a roster is never changed after it.
    registration_closes: atSchema,
    deadline: atSchema,
    roster_locks: atSchema.optional(),
    max_teams: z.number().int().min(1).max(MAX_TEAMS),
    team_size: z.number().int().min(1).max(MAX_TEAM_SIZE),
    max_bots: z.number().int().min(1).max(MAX_BOTS),
  })
  .superRefine((s, ctx) => {
    const start = Date.parse(s.starts_at);
    const closes = Date.parse(s.registration_closes);
    const deadline = Date.parse(s.deadline);
    if (closes < start)
      ctx.addIssue({
        code: "custom",
        path: ["registration_closes"],
        message: "can't close before the start",
      });
    if (closes > deadline)
      ctx.addIssue({
        code: "custom",
        path: ["registration_closes"],
        message: "can't close after the deadline",
      });
    if (s.roster_locks !== undefined) {
      const locks = Date.parse(s.roster_locks);
      if (locks < closes)
        ctx.addIssue({
          code: "custom",
          path: ["roster_locks"],
          message: "can't lock rosters before sign-up closes",
        });
      if (locks > deadline)
        ctx.addIssue({
          code: "custom",
          path: ["roster_locks"],
          message: "can't lock rosters after the deadline",
        });
    }
    if (deadline - start < MIN_BUILD_MINUTES * MINUTE)
      ctx.addIssue({
        code: "custom",
        path: ["deadline"],
        message: `at least ${MIN_BUILD_MINUTES} minutes after the start`,
      });
    if (deadline - start > MAX_BUILD_DAYS * 24 * 60 * MINUTE)
      ctx.addIssue({
        code: "custom",
        path: ["deadline"],
        message: `at most ${MAX_BUILD_DAYS} days after the start`,
      });
  });

export type Settings = z.output<typeof settingsSchema>;

// Older listings don't need a rewrite: their host is their only judge.
export function judgesFor(settings: Settings): readonly string[] {
  return settings.judges ?? [settings.host];
}

// A new listing's settings: as given, with the roster lock filled in when
// the operator left it out.
export function withRosterLock(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return input;
  const o = input as Record<string, unknown>;
  const spell = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
  // One spelling, as the default's and a moved deadline's, when it's a time.
  if (o.roster_locks !== undefined) {
    const set = Date.parse(String(o.roster_locks));
    return typeof o.roster_locks === "string" &&
      isUtc(o.roster_locks) &&
      !Number.isNaN(set)
      ? { ...o, roster_locks: spell(set) }
      : input;
  }
  const closes = Date.parse(String(o.registration_closes));
  const deadline = Date.parse(String(o.deadline));
  // Settings the schema will refuse anyway get no lock to be refused too.
  if (Number.isNaN(closes) || Number.isNaN(deadline) || closes > deadline)
    return input;
  const locks = Math.max(closes, deadline - ROSTER_LOCK_MINUTES * MINUTE);
  return { ...o, roster_locks: spell(locks) };
}
