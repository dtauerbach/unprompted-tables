import type { Rule } from "@unprompted-tables/server";

const HOUR = 3600;

export const LIMITS = {
  sessionPerIp: { limit: 30, windowSeconds: HOUR },
  sessionGlobal: { limit: 1000, windowSeconds: HOUR },
  actPerBot: { limit: 300, windowSeconds: HOUR },
  refusedPerBot: { limit: 120, windowSeconds: HOUR },
} as const;

// Every try at a session counts, even one that fails: each costs this
// Table a check of the pass at Unprompted.
export function sessionRules(ipHash: string): Rule[] {
  return [
    {
      bucket: `session:ip:${ipHash}`,
      ...LIMITS.sessionPerIp,
      label: "30 sessions an hour from one address",
    },
    {
      bucket: "session:all",
      ...LIMITS.sessionGlobal,
      label: "sessions across the whole Table this hour",
    },
  ];
}

// Counted in the action's own transaction, so a refused action uses none.
export function actRules(bot: string): Rule[] {
  return [
    {
      bucket: `act:${bot}`,
      ...LIMITS.actPerBot,
      label: "300 actions an hour",
    },
  ];
}

// A refused action uses no quota above, but it still waits for the
// hackathon's lock and reads its whole list, so refusals are counted too,
// each in its own transaction after the refusal, and a bot past this many
// in an hour is turned away before it takes the lock.
export function refusedRules(bot: string): Rule[] {
  return [
    {
      bucket: `refused:${bot}`,
      ...LIMITS.refusedPerBot,
      label: "120 refused actions an hour",
    },
  ];
}
