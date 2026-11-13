import { cursorScope, openCursor, sealCursor } from "@unprompted-tables/server";
import { allSeatings } from "../exec/solver";
import { delta, EXECUTIVES, type FloorAction, view } from "./game";
import { FEUD, floorMatch, ID, later, PLAYERS } from "./test-harness";

// A scripted open floor played in memory, to measure what a whole match
// costs its readers: the old loop (the whole view on every read and every
// action's answer) against the delta loop (one whole read, then only
// what's new). Each assistant reads every `poll` seconds and talks
// `talk` times, a third of it privately; motions come every few minutes
// and everyone votes on each.

export function simulateFloor(
  opts: { poll?: number; talk?: number; chars?: number; seed?: string } = {},
) {
  const poll = opts.poll ?? 30;
  const talk = opts.talk ?? 16;
  const chars = opts.chars ?? 300;
  const g = floorMatch(FEUD, opts.seed ?? "read-cost");
  const scope = (p: string) => cursorScope("dinner", ID, p);
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  type Reader = {
    cursor: string;
    old: number;
    new: number;
    reads: number;
    got: unknown[];
  };
  const readers = new Map<string, Reader>();
  for (const p of PLAYERS) {
    const v = view(g.state, g.events, p, { now: later(0) });
    const d = delta(g.state, g.events, p, null, { now: later(0) });
    const cursor = sealCursor(scope(p), d.seen);
    readers.set(p, {
      cursor,
      old: bytes(v),
      new: bytes({ ...v, next: cursor }),
      reads: 1,
      got: [],
    });
  }
  const read = (p: string, sec: number) => {
    const r = readers.get(p) as Reader;
    g.tick(sec);
    const now = later(sec);
    r.old += bytes(view(g.state, g.events, p, { now }));
    const d = delta(g.state, g.events, p, openCursor(scope(p), r.cursor), {
      now,
    });
    if ("resync" in d.view) throw new Error(`${p} resynced`);
    r.got.push(...d.view.events);
    r.cursor = sealCursor(scope(p), d.seen);
    r.new += bytes({ ...d.view, next: r.cursor });
    r.reads++;
  };
  const execOf = (p: string) =>
    EXECUTIVES[g.state.cast[PLAYERS.indexOf(p)] as number] as string;
  const actions = new Map<number, [string, FloorAction][]>();
  const at = (sec: number, p: string, a: FloorAction) => {
    actions.set(sec, [...(actions.get(sec) ?? []), [p, a]]);
  };
  const words = "the seating by the window suits us if Sage sits between ";
  PLAYERS.forEach((p, k) => {
    for (let i = 0; i < talk; i++) {
      const others = PLAYERS.filter((q) => q !== p);
      const to =
        i % 3 === 2
          ? [execOf(others[(i + k) % others.length] as string)]
          : null;
      at(20 + k * 7 + i * 95, p, {
        kind: "talk",
        text: `${execOf(p)} ${i}: ${words.repeat(20)}`.slice(0, chars),
        ...(to ? { to } : {}),
      });
    }
  });
  // A motion every four minutes from the floor's opening, each mover in
  // turn, everyone else voting a minute later: alternately yes and no.
  const seatings = allSeatings(5).map((s) =>
    s.map((i) => EXECUTIVES[i] as string),
  );
  for (let m = 0; m < 6; m++) {
    const sec = 200 + m * 240;
    const mover = PLAYERS[m % 5] as string;
    at(sec, mover, { kind: "motion", seating: seatings[m * 7] as string[] });
    PLAYERS.filter((p) => p !== mover).forEach((p, k) => {
      at(sec + 30 + k * 3, p, {
        kind: "vote",
        motion: m + 1,
        ballot: (m + k) % 2 === 0 ? "yes" : "no",
      });
    });
  }
  const end = g.served();
  for (let sec = 1; sec <= end; sec++) {
    for (const [p, a] of actions.get(sec) ?? []) {
      // A vote that closed early, or a seating that already stands, is
      // refused with a short error: skip it.
      try {
        g.run(p, a, sec);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (
          !["voting_closed", "already_standing", "already_moved"].includes(
            code ?? "",
          )
        )
          throw e;
        continue;
      }
      // The action's answer.
      read(p, sec);
    }
    for (const p of PLAYERS) if (sec % poll === 0) read(p, sec);
  }
  // Everyone reads the result once.
  for (const p of PLAYERS) read(p, end + 1);
  const all = [...readers.values()];
  const sum = (f: (r: Reader) => number) => all.reduce((n, r) => n + f(r), 0);
  return {
    g,
    readers,
    seconds: end,
    reads: sum((r) => r.reads),
    old: sum((r) => r.old),
    new: sum((r) => r.new),
  };
}
