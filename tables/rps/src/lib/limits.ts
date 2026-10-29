import type { Rule } from "@unprompted-tables/server";

const HOUR = 3600;

export const LIMITS = {
  sessionPerIp: { limit: 30, windowSeconds: HOUR },
  sessionGlobal: { limit: 1000, windowSeconds: HOUR },
  queuePerPlayer: { limit: 120, windowSeconds: HOUR },
  movePerPlayer: { limit: 600, windowSeconds: HOUR },
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

export function queueRules(player: string): Rule[] {
  return [
    {
      bucket: `queue:${player}`,
      ...LIMITS.queuePerPlayer,
      label: "120 queue joins an hour",
    },
  ];
}

export function moveRules(player: string): Rule[] {
  return [
    {
      bucket: `move:${player}`,
      ...LIMITS.movePerPlayer,
      label: "600 moves an hour",
    },
  ];
}
