import {
  EXECUTIVES,
  type FloorDeal,
  type FloorEvent,
  type FloorState,
  points,
  scoreOf,
  tableBounds,
} from "./game";
import { challengers, N, pointsTable, SEATINGS } from "./generate";

// What a finished match measures (design.md, section 4), computed from the
// events and the deal, every one exact.
// Only for a match that's over: most of these need the secrets.

export type Measures = {
  // Passes after the first.
  changedHands: number;
  moved: number;
  passed: number;
  failed: number;
  void: number;
  // For each overturn, the assistants who voted yes on the standing
  // seating and yes on the motion that replaced it.
  switches: number;
  switchesBy: number[];
  // Yes votes (and motions) for a seating worth less to the voter than
  // what stood at the time (no deal, if nothing stood).
  againstOwn: number;
  againstOwnBy: number[];
  // Secrets named rightly, of how many dealt, and whose.
  exposed: number;
  exposedExecutives: string[];
  dealt: number;
  guessesRight: number;
  guessesWrong: number;
  total: number;
  highestTotal: number;
  lowest: number;
  // The most any seating gives its lowest executive.
  bestLowest: number;
  // Seatings three executives all prefer to the final one.
  challengersLeft: number;
  fewestChallengers: number;
  // How long the final seating had stood when dinner came, in minutes.
  minutesStood: number | null;
  privateShare: number;
  // Each pass's yes set, by executive, in order.
  passes: { motion: number; yes: string[] }[];
};

export function measure(s: FloorState, events: FloorEvent[]): Measures {
  const end = s.end;
  if (!end) throw new Error("measures need a finished match");
  const d: FloorDeal = end.deal;
  const exec = (player: string) => s.cast[s.players.indexOf(player)] as number;
  const t = tableBounds(d, s.rules.no_deal_margin);

  // Votes, in the order they happened.
  let standing: number[] | null = null;
  const yesOf = new Map<number, Set<number>>();
  const seatingOf = new Map<number, number[]>();
  const againstOwnBy = EXECUTIVES.map(() => 0);
  const worth = (i: number, order: number[] | null) =>
    order ? (points(d, order)[i] as number) : (t.noDeal[i] as number);
  const passes: { motion: number; yes: Set<number> }[] = [];
  for (const { body: b } of events) {
    if (b.kind === "propose") {
      const i = exec(b.player);
      const order = b.seating.map((x) => EXECUTIVES.indexOf(x));
      seatingOf.set(b.motion, order);
      yesOf.set(b.motion, new Set([i]));
      if (worth(i, order) < worth(i, standing))
        againstOwnBy[i] = (againstOwnBy[i] as number) + 1;
    } else if (b.kind === "back" && b.ballot === "yes") {
      const i = exec(b.player);
      const order = seatingOf.get(b.motion) as number[];
      yesOf.get(b.motion)?.add(i);
      if (worth(i, order) < worth(i, standing))
        againstOwnBy[i] = (againstOwnBy[i] as number) + 1;
    } else if (b.kind === "motion" && b.passed) {
      standing = seatingOf.get(b.motion) ?? null;
      passes.push({ motion: b.motion, yes: yesOf.get(b.motion) ?? new Set() });
    }
  }
  const switchesBy = EXECUTIVES.map(() => 0);
  for (let k = 1; k < passes.length; k++) {
    const before = passes[k - 1]?.yes as Set<number>;
    for (const i of passes[k]?.yes ?? [])
      if (before.has(i)) switchesBy[i] = (switchesBy[i] as number) + 1;
  }

  const motions = s.motions;
  const by = (k: string) => motions.filter((m) => m.close?.by === k).length;
  const passedCount = motions.filter((m) => m.close?.passed).length;

  // Naming.
  const sc = scoreOf(s, s.standing?.seating ?? null);
  let guessesRight = 0;
  let guessesWrong = 0;
  const found = new Set<string>();
  for (const gs of Object.values(s.guesses))
    for (const g of gs) {
      const x = EXECUTIVES.indexOf(g.executive);
      if ((d.secrets[x] as number[]).includes(EXECUTIVES.indexOf(g.dislikes))) {
        guessesRight++;
        found.add(`${g.executive} ${g.dislikes}`);
      } else guessesWrong++;
    }

  // Every message, public or private, for the private share.
  const talk = events.flatMap((e) =>
    e.body.kind === "talk"
      ? [{ ...e.body, open: e.audience === "public" }]
      : [],
  );

  const P = pointsTable(d.weights);
  const final = end.seating_points;
  const totals = P.map((u) => u.reduce((a, b) => a + b, 0));
  const dom = challengers(P);
  const challengersLeft = SEATINGS.reduce((n, _s, y) => {
    const u = P[y] as number[];
    let better = 0;
    for (let i = 0; i < N; i++)
      if ((u[i] as number) > (final[i] as number)) better++;
    return n + (better >= 3 ? 1 : 0);
  }, 0);
  const minutesStood = s.standing
    ? Math.round((Date.parse(end.at) - Date.parse(s.standing.since)) / 6000) /
      10
    : null;
  return {
    changedHands: Math.max(0, passedCount - 1),
    moved: motions.length,
    passed: passedCount,
    failed: by("yes") + by("no") + by("time") - passedCount,
    void: by("void"),
    switches: switchesBy.reduce((a, b) => a + b, 0),
    switchesBy,
    againstOwn: againstOwnBy.reduce((a, b) => a + b, 0),
    againstOwnBy,
    exposed: found.size,
    exposedExecutives: sc.exposed,
    dealt: d.secrets.reduce((n, x) => n + x.length, 0),
    guessesRight,
    guessesWrong,
    total: final.reduce((a, b) => a + b, 0),
    highestTotal: Math.max(...totals),
    lowest: Math.min(...final),
    bestLowest: Math.max(...P.map((u) => Math.min(...u))),
    challengersLeft,
    fewestChallengers: Math.min(...dom),
    minutesStood,
    privateShare: talk.length
      ? talk.filter((m) => !m.open).length / talk.length
      : 0,
    passes: passes.map((p) => ({
      motion: p.motion,
      yes: [...p.yes].sort((a, b) => a - b).map((i) => EXECUTIVES[i] as string),
    })),
  };
}
