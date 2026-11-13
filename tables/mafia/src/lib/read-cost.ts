import { cursorScope, openCursor, sealCursor } from "@unprompted-tables/server";
import {
  type Action,
  act,
  advance,
  apply,
  delta,
  type MatchEvent,
  type MatchState,
  replay,
  view,
} from "./match";
import type { Rules } from "./settings";

// A scripted match played in memory, for the delta tests and to measure
// what a whole match costs its readers: the old loop (the whole view on
// every poll and every action's answer) against the delta loop (one whole
// read, then only what's new). No database, no model, no randomness
// beyond the deal, which is fixed by passing roles in.

export type Played = { state: MatchState; log: MatchEvent[] };

// The deal, overridden so twin matches can share it.
export function dealt(players: string[], rules: Rules, mafia: string[]) {
  const at = new Date("2026-11-12T03:00:00.000Z");
  const log: MatchEvent[] = [
    {
      audience: "public",
      body: {
        kind: "start",
        rules_version: 1,
        at: at.toISOString(),
        players,
        rules,
      },
    },
    ...players.map(
      (player): MatchEvent => ({
        audience: [player],
        body: {
          kind: "role",
          at: at.toISOString(),
          player,
          side: mafia.includes(player) ? "mafia" : "village",
          partners: mafia.includes(player)
            ? mafia.filter((p) => p !== player)
            : [],
        },
      }),
    ),
  ];
  return { log, at };
}

export type Reader = {
  player: string | null;
  cursor: string;
  // Bytes fetched by this reader, old loop and delta loop.
  old: number;
  new: number;
  reads: number;
  // Every event the delta loop was shown, in order.
  got: unknown[];
};

export type Sim = ReturnType<typeof simulate>;

// Plays a match second by second. Every living player polls every
// `poll` seconds; each phase runs to its deadline with talk spread
// through it (the "modest" game the research measured); `talk` messages
// of `chars` characters per living actor per talk phase. Votes follow
// `plan`: the day and night targets in order.
export function simulate(opts: {
  players: string[];
  mafia: string[];
  plan: string[];
  talk?: number;
  chars?: number;
  poll?: number;
  rules?: Partial<Rules>;
  nightTalk?: (day: number) => number;
}) {
  const rules: Rules = {
    players: opts.players.length,
    reveal_on_death: true,
    talk_seconds: 120,
    vote_seconds: 60,
    max_days: 20,
    ...opts.rules,
  };
  const { log, at } = dealt(opts.players, rules, opts.mafia);
  let state = replay("m_simulatedmatc", log);
  const events = [...log];
  const poll = opts.poll ?? 12;
  const talk = opts.talk ?? 2;
  const chars = opts.chars ?? 300;
  const readers = new Map<string, Reader>();
  const id = state.id;
  const scopeOf = (p: string | null) => cursorScope("mafia", id, p);
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  // First read: the whole view, with its cursor, for both loops.
  for (const p of opts.players) {
    const v = view(state, events, p);
    const seen = delta(state, events, p, null).seen;
    const r: Reader = {
      player: p,
      cursor: sealCursor(scopeOf(p), seen),
      old: bytes(v),
      new: bytes({ ...v, next: "c1.".padEnd(46, "x") }),
      reads: 1,
      got: [...v.events],
    };
    readers.set(p, r);
  }
  const read = (p: string, now: Date) => {
    const r = readers.get(p) as Reader;
    const late = advance(state, now);
    events.push(...late);
    state = late.reduce(apply, state);
    r.old += bytes(view(state, events, p));
    const d = delta(state, events, p, openCursor(scopeOf(p), r.cursor));
    if (d.view.resync) throw new Error(`${p} resynced`);
    r.got.push(...d.view.events);
    r.cursor = sealCursor(scopeOf(p), d.seen);
    r.new += bytes({ ...d.view, next: r.cursor });
    r.reads++;
  };
  const move = (p: string, action: Action, now: Date) => {
    const late = advance(state, now);
    events.push(...late);
    state = late.reduce(apply, state);
    const added = act(state, p, action, now);
    events.push(...added);
    state = added.reduce(apply, state);
    // Each action's answer: the whole view, or a delta from the cursor.
    read(p, now);
  };
  let plan = 0;
  let t = 0;
  const clock = () => new Date(at.getTime() + t * 1000);
  const text = (p: string, i: number) =>
    `${p} says ${i}: ${"lorem ipsum dolor sit amet ".repeat(20)}`.slice(
      0,
      chars,
    );
  while (state.phase !== "over") {
    const phase = state.phase;
    const turn = state.turn;
    const actors = state.alive.filter(
      (p) => !phase.startsWith("night") || state.roles[p] === "mafia",
    );
    const length = phase.endsWith("talk")
      ? rules.talk_seconds
      : rules.vote_seconds;
    const per = phase.startsWith("night")
      ? (opts.nightTalk?.(state.day) ?? talk)
      : talk;
    // When each actor talks, spread across the phase; ready near its end.
    const schedule = new Map<number, [string, Action][]>();
    const add = (sec: number, p: string, a: Action) => {
      schedule.set(sec, [...(schedule.get(sec) ?? []), [p, a]]);
    };
    if (phase.endsWith("talk"))
      actors.forEach((p, k) => {
        for (let i = 0; i < per; i++)
          add(
            1 +
              Math.floor(
                ((i * actors.length + k) * (length - 10)) /
                  (per * actors.length),
              ),
            p,
            { turn, kind: "talk", text: text(p, i) },
          );
      });
    else {
      const target = opts.plan[plan] ?? null;
      plan++;
      actors.forEach((p, k) => {
        add(5 + k, p, {
          turn,
          kind: "vote",
          target: target === p ? null : target,
        });
      });
    }
    const start = t;
    // A function, so the narrowing of the outer loop doesn't stick.
    const live = () => state.phase !== "over";
    while (state.turn === turn && live()) {
      for (const [p, a] of schedule.get(t - start) ?? [])
        if (state.turn === turn) move(p, a, clock());
      if (state.turn !== turn) break;
      for (const p of state.alive)
        if ((t - start) % poll === poll - 1) read(p, clock());
      t++;
      if (t - start > length + 1) {
        // The deadline closes it on the next look.
        for (const p of state.alive) read(p, clock());
      }
    }
  }
  // Everyone, the dead too, reads the result once.
  for (const p of opts.players) read(p, clock());
  const all = [...readers.values()];
  const sum = (f: (r: Reader) => number) => all.reduce((n, r) => n + f(r), 0);
  return {
    state,
    events,
    readers,
    seconds: t,
    days: state.day,
    reads: sum((r) => r.reads),
    old: sum((r) => r.old),
    new: sum((r) => r.new),
  };
}
