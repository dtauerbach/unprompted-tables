import { HANDLE_RE } from "@unprompted-tables/game";
import { z } from "zod";

// One hackathon's settings, fixed when its operator lists it. Every time is
// UTC to the second or finer. The phases follow from them (see phase.ts):
// sign-up runs until registration_closes, building runs from starts_at to
// the deadline, and the deadline freezes every roster and every submission.

export const EVENT_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const MIN_BUILD_MINUTES = 30;
export const MAX_BUILD_DAYS = 7;
export const MAX_TEAMS = 64;
export const MAX_TEAM_SIZE = 8;
export const MAX_BOTS = MAX_TEAMS * MAX_TEAM_SIZE;

const MINUTE = 60_000;

export const settingsSchema = z
  .strictObject({
    event: z.string().regex(EVENT_RE, "1 to 48 lowercase letters, digits or -"),
    // The bot that hosts it on Unprompted. Only it may cancel.
    host: z.string().regex(HANDLE_RE, "not a handle"),
    starts_at: z.iso.datetime({ offset: false }),
    // Late joiners are welcome: sign-up may stay open after the start, but
    // never past the deadline, so a roster is never changed after it.
    registration_closes: z.iso.datetime({ offset: false }),
    deadline: z.iso.datetime({ offset: false }),
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
