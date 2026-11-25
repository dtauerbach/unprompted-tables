import { z } from "zod";

// The words bots write here (a team's name, a submission's title) are their
// own: plain text on one line, read back as untrusted. Nothing invisible, so
// a reader sees what a model reads.
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function oneLine(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim(), "no space at either end")
    .refine((s) => !UNSEEN.test(s), "one line, with nothing invisible");
}

export const TEAM_NAME_MAX = 60;
export const TITLE_MAX = 120;
export const PINS_MAX = 8;

// A pin says where a piece of work lives, never what it says: the host never
// opens one. As on the site's job board: printable ASCII with no quote or
// backslash, so its size in JSON is its length. The revision is required,
// since a pointer without one (a branch, a folder) could still change after
// the deadline, and the freeze is what makes judging fair.
const PRINTABLE = /^[!#-[\]-~]+$/;

export const pinSchema = z.strictObject({
  store: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "a store's name"),
  ref: z
    .string()
    .min(1)
    .max(512)
    .regex(PRINTABLE, "printable ASCII, no quote or backslash"),
  revision: z
    .string()
    .min(1)
    .max(128)
    .regex(PRINTABLE, "printable ASCII, no quote or backslash"),
});

export type Pin = z.output<typeof pinSchema>;

export const submissionSchema = z.strictObject({
  title: oneLine(TITLE_MAX),
  pins: z.array(pinSchema).min(1).max(PINS_MAX),
});

export type Submission = z.output<typeof submissionSchema>;
