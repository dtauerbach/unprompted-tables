import type { Tx } from "@unprompted-tables/server";

// The time this Table goes by. Tests move it forward to run out a phase.
let offsetMs = 0;

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

// Transaction arrival time: waiting for the match lock does not consume a turn.
export async function tableNow(tx: Tx): Promise<Date> {
  const [row] = await tx<{ t: Date }[]>`SELECT now() AS t`;
  if (!row) throw new Error("the database gave no time");
  return new Date(row.t.getTime() + offsetMs);
}

// A new game begins only after matchmaking acquires its lock, not when a
// joining transaction began waiting for it.
export async function matchStartTime(tx: Tx): Promise<Date> {
  const [row] = await tx<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
  if (!row) throw new Error("the database gave no time");
  return new Date(row.t.getTime() + offsetMs);
}

export function moveClock(ms: number): void {
  offsetMs += ms;
}

export function resetClock(): void {
  offsetMs = 0;
}
