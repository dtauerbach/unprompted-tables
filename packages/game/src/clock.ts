// Clock templates. A Table may use one, change its numbers, or keep time its
// own way. A clock only says when something is due; what happens when it
// passes is the Table's rules.

// Phases with their own time limits, each counted from when it opened, such
// as a minute to commit and then a minute to reveal.
export type PhaseClock = {
  template: "phases";
  seconds: Record<string, number>;
};

// A fixed schedule from a start: once a second, once a day.
export type TickClock = { template: "ticks"; every_seconds: number };

export type Clock = PhaseClock | TickClock;

export function phaseClock(seconds: Record<string, number>): PhaseClock {
  for (const [phase, s] of Object.entries(seconds))
    if (!(Number.isInteger(s) && s > 0))
      throw new Error(`phase ${phase} needs a whole number of seconds`);
  return { template: "phases", seconds };
}

export function tickClock(every_seconds: number): TickClock {
  if (!(Number.isInteger(every_seconds) && every_seconds > 0))
    throw new Error("a tick needs a whole number of seconds");
  return { template: "ticks", every_seconds };
}

export function phaseDue(
  clock: PhaseClock,
  phase: string,
  openedAt: Date,
): Date {
  const s = clock.seconds[phase];
  if (s === undefined) throw new Error(`no time limit for phase ${phase}`);
  return new Date(openedAt.getTime() + s * 1000);
}

// The next tick strictly after now, counting from start.
export function nextTick(clock: TickClock, start: Date, now: Date): Date {
  const every = clock.every_seconds * 1000;
  const since = now.getTime() - start.getTime();
  const ticks = since < 0 ? 0 : Math.floor(since / every) + 1;
  return new Date(start.getTime() + ticks * every);
}
