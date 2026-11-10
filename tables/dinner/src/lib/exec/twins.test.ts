import { describe, expect, it } from "vitest";
import { pick, rng, shuffle } from "../rng";
import { execFeed } from "./feed";
import {
  act,
  advance,
  apply,
  briefFor,
  EXECUTIVES,
  type ExecAction,
  type ExecDeal,
  type ExecEvent,
  type ExecState,
  executiveOf,
  type OpenRound,
  playerOf,
  replay,
  start,
  view,
} from "./game";
import { EXEC_VARIANTS, type ExecVariant } from "./variants";

// Twin worlds: two matches that differ only in what a reader mustn't know
// (other briefs, the configuration, the roles, the seed, later proposers, a
// sealed ballot, a private message not sent to them) must give that reader,
// the public and a stranger byte-identical views, and the same live feed.
// Played step by step, compared after every move.

const MATCHES = 10;

const TABLE = { name: "Dinner party", game: "dinner-party" };
const players = ["alice", "bobby", "carol", "david", "ellen"];
const ID = "m_abcdefghijkl";
const T0 = Date.parse("2026-11-10T03:00:00.000Z");
type World = { events: ExecEvent[]; state: ExecState };
const mk = (events: ExecEvent[]): World => ({
  events,
  state: replay(ID, events),
});
function tick(w: World, at: Date): World {
  const late = advance(w.state, at);
  return late.length
    ? { events: [...w.events, ...late], state: late.reduce(apply, w.state) }
    : w;
}
function step(w0: World, player: string, action: ExecAction, at: Date): World {
  const w = tick(w0, at);
  const added = act(w.state, player, action, at);
  return {
    events: [...w.events, ...added],
    state: added.reduce(apply, w.state),
  };
}
const seen = (w: World, who: string | null, now: Date) =>
  JSON.stringify(view(w.state, w.events, who, { now }));
const feedOf = (w: World) => JSON.stringify(execFeed(w.state, w.events, TABLE));
let compared = 0;
function same(
  label: string,
  a: World,
  b: World,
  readers: (string | null)[],
  now: Date,
) {
  for (const who of readers) {
    const x = seen(a, who, now),
      y = seen(b, who, now);
    compared++;
    if (x !== y) {
      let i = 0;
      while (x[i] === y[i]) i++;
      throw new Error(
        `${label}: view for ${who} differs at ${i}: ...${x.slice(Math.max(0, i - 80), i + 120)} VS ...${y.slice(Math.max(0, i - 80), i + 120)}`,
      );
    }
  }
  const x = feedOf(a),
    y = feedOf(b);
  compared++;
  if (x !== y) {
    let i = 0;
    while (x[i] === y[i]) i++;
    throw new Error(
      `${label}: feed differs at ${i}: ...${x.slice(Math.max(0, i - 80), i + 160)} VS ...${y.slice(Math.max(0, i - 80), i + 160)}`,
    );
  }
}

// World B: the same match as A for player P, with everything P must not
// know changed: the other executives' weights, the configuration's name and
// level, the roles, the seed, and the proposers of the rounds from `from` on.
function hiddenTwin(
  a: ExecEvent[],
  P: string,
  r: () => number,
  from: number,
): ExecEvent[] {
  const s = replay(ID, a);
  const mine = executiveOf(s, P) as number;
  const d = s.deal as ExecDeal;
  const weights = d.weights.map((row, i) =>
    i === mine ? row : row.map((_, j) => (j === i ? 0 : Math.floor(r() * 11))),
  );
  const draws = d.draws.map((x, k) =>
    k >= from ? (x + 1 + Math.floor(r() * 4)) % 5 : x,
  );
  const deal: ExecDeal = {
    ...d,
    seed: "0123456789abcdef0123456789abcdef",
    variant: "other",
    config: d.config === "standoff" ? "compromise" : "standoff",
    level: 9,
    roles: [...d.roles].reverse(),
    weights,
    draws,
  };
  return a.map((e) => {
    if (e.body.kind === "deal") return { ...e, body: { ...e.body, deal } };
    if (e.body.kind === "brief" && e.body.player !== P) {
      const i = executiveOf(s, e.body.player) as number;
      return {
        ...e,
        body: {
          kind: "brief",
          at: e.body.at,
          player: e.body.player,
          ...briefFor(deal, i, s.rules),
        },
      } as ExecEvent;
    }
    return e;
  });
}

describe("what a reader can't tell apart", () => {
  it("would notice a difference a reader is meant to see", () => {
    const v = EXEC_VARIANTS.standoff as ExecVariant;
    const a0 = start(players, v, new Date(T0), "sanity");
    const rr = rng("sanity", "nonint");
    const r = () => pick(rr, 1_000_000) / 1_000_000;
    // A twin hiding everything from bobby changes alice's brief.
    const twin = mk(hiddenTwin(a0, "bobby", r, 3));
    expect(() => same("sanity", mk(a0), twin, ["alice"], new Date(T0))).toThrow(
      /view for alice differs/,
    );
    // A private message is seen by its recipient.
    const W = mk(a0);
    const me = EXECUTIVES[executiveOf(W.state, "alice") as number] as string;
    const to = EXECUTIVES.find((x) => x !== me) as string;
    const reader = playerOf(W.state, EXECUTIVES.indexOf(to));
    const loud = step(
      W,
      "alice",
      { kind: "talk", text: "psst", to: [to] },
      new Date(T0 + 1000),
    );
    expect(() =>
      same("sanity", loud, W, [reader], new Date(T0 + 2000)),
    ).toThrow();
  });

  it("gives identical views and feeds in twin worlds", () => {
    let worlds = 0;
    for (const cfg of [
      "aligned",
      "compromise",
      "standoff",
      "scramble",
      "exec-mix",
    ]) {
      const v = EXEC_VARIANTS[cfg] as ExecVariant;
      for (let m = 0; m < MATCHES; m++) {
        const seed = `nonint-${cfg}-${m}`;
        const rr = rng(seed, "nonint");
        const r = () => pick(rr, 1_000_000) / 1_000_000;
        const a0 = start(players, v, new Date(T0), seed);
        for (const P of players) {
          // 1. Hidden deal: P, the public and a stranger can't tell A from B while
          // the rounds whose proposers are the same are being played.
          for (const from of [1, 2, 3]) {
            let A = mk(a0);
            let B = mk(hiddenTwin(a0, P, r, from));
            let now = T0;
            const readers = [P, null, "stranger"];
            same(
              `deal/${cfg}/${m}/${P}/from${from} start`,
              A,
              B,
              readers,
              new Date(now),
            );
            // Play `from` rounds, each failing by a no vote, comparing all along.
            for (let round = 1; round <= from; round++) {
              const clocks = round === 1 ? v.clocks.first : v.clocks.later;
              const opened = Date.parse((A.state.round as OpenRound).opened);
              if (
                (B.state.round as OpenRound).opened !==
                (A.state.round as OpenRound).opened
              )
                throw new Error("clock drift");
              now = opened + 5_000;
              const propA = playerOf(
                A.state,
                (A.state.round as OpenRound).proposer,
              );
              const propB = playerOf(
                B.state,
                (B.state.round as OpenRound).proposer,
              );
              if (propA !== propB)
                throw new Error("proposers differ too early");
              const talker = players[pick(rr, 5)] as string;
              const me = EXECUTIVES[
                executiveOf(A.state, talker) as number
              ] as string;
              const others = EXECUTIVES.filter((x) => x !== me);
              const to = shuffle(rr, others).slice(0, 1 + pick(rr, 3));
              for (const act1 of [
                { kind: "talk", text: `open ${round}` },
                { kind: "talk", text: `psst ${round}`, to },
              ] as ExecAction[]) {
                A = step(A, talker, act1, new Date(now));
                B = step(B, talker, act1, new Date(now));
                now += 1_000;
                same(
                  `deal/${cfg}/${m}/${P}/from${from} talk r${round}`,
                  A,
                  B,
                  readers,
                  new Date(now),
                );
              }
              now = opened + clocks.talk_min * 1000 + 10_000;
              const seating = shuffle(rr, EXECUTIVES);
              A = step(
                A,
                propA,
                { kind: "propose", round, seating },
                new Date(now),
              );
              B = step(
                B,
                propA,
                { kind: "propose", round, seating },
                new Date(now),
              );
              same(
                `deal/${cfg}/${m}/${P}/from${from} filed r${round}`,
                A,
                B,
                readers,
                new Date(now),
              );
              const voters = players.filter((p) => p !== propA);
              // Three no votes, then let the clock close it: fails under both rules.
              for (const p of voters.slice(0, 3)) {
                now += 1_000;
                A = step(
                  A,
                  p,
                  { kind: "vote", round, ballot: "no" },
                  new Date(now),
                );
                B = step(
                  B,
                  p,
                  { kind: "vote", round, ballot: "no" },
                  new Date(now),
                );
                same(
                  `deal/${cfg}/${m}/${P}/from${from} voted r${round}`,
                  A,
                  B,
                  readers,
                  new Date(now),
                );
              }
              if (round < from) {
                now += clocks.vote_seconds * 1000 + 1_000;
                A = tick(A, new Date(now));
                B = tick(B, new Date(now));
                same(
                  `deal/${cfg}/${m}/${P}/from${from} closed r${round}`,
                  A,
                  B,
                  readers,
                  new Date(now),
                );
              }
            }
            worlds++;
          }
        }
        // 2. A sealed ballot: yes, no or not cast look the same to everyone else.
        {
          let W = mk(a0);
          const clocks = v.clocks.first;
          let now = T0 + clocks.talk_min * 1000 + 10_000;
          const prop = playerOf(W.state, (W.state.round as OpenRound).proposer);
          W = step(
            W,
            prop,
            { kind: "propose", round: 1, seating: shuffle(rr, EXECUTIVES) },
            new Date(now),
          );
          const voters = players.filter((p) => p !== prop);
          const X = voters[pick(rr, 4)] as string;
          now += 5_000;
          const yes = step(
            W,
            X,
            { kind: "vote", round: 1, ballot: "yes" },
            new Date(now),
          );
          const no = step(
            W,
            X,
            { kind: "vote", round: 1, ballot: "no" },
            new Date(now),
          );
          const readers = [null, "stranger", ...players.filter((p) => p !== X)];
          now += 5_000;
          same(`ballot yes/no ${cfg}/${m}`, yes, no, readers, new Date(now));
          same(`ballot yes/none ${cfg}/${m}`, yes, W, readers, new Date(now));
          // Two more voters, differently: still nothing to tell apart.
          const [Y, Z] = voters.filter((p) => p !== X) as [string, string];
          const yes2 = step(
            step(
              yes,
              Y,
              { kind: "vote", round: 1, ballot: "no" },
              new Date(now),
            ),
            Z,
            { kind: "vote", round: 1, ballot: "yes" },
            new Date(now),
          );
          const no2 = step(
            step(
              no,
              Y,
              { kind: "vote", round: 1, ballot: "yes" },
              new Date(now),
            ),
            Z,
            { kind: "vote", round: 1, ballot: "no" },
            new Date(now),
          );
          const last = voters.find(
            (p) => p !== X && p !== Y && p !== Z,
          ) as string;
          same(
            `ballot three ${cfg}/${m}`,
            yes2,
            no2,
            [null, "stranger", prop, last],
            new Date(now + 1000),
          );
          same(
            `ballot three/none ${cfg}/${m}`,
            yes2,
            W,
            [null, "stranger", prop, last],
            new Date(now + 1000),
          );
          worlds++;
        }
        // 3. A private message: those it didn't go to can't tell it was sent.
        {
          const W = mk(a0);
          let now = T0 + 5_000;
          const X = players[pick(rr, 5)] as string;
          const me = EXECUTIVES[executiveOf(W.state, X) as number] as string;
          const others = EXECUTIVES.filter((x) => x !== me);
          const to = shuffle(rr, others).slice(0, 1 + pick(rr, 3));
          const toPlayers = to.map((x) =>
            playerOf(W.state, EXECUTIVES.indexOf(x)),
          );
          const quiet = W;
          const loud = step(
            W,
            X,
            { kind: "talk", text: "between us", to },
            new Date(now),
          );
          const readers = [
            null,
            "stranger",
            ...players.filter((p) => p !== X && !toPlayers.includes(p)),
          ];
          now += 5_000;
          same(`private ${cfg}/${m}`, loud, quiet, readers, new Date(now));
          // And after later public events too.
          const other = players.find((p) => p !== X) as string;
          const loud2 = step(
            loud,
            other,
            { kind: "talk", text: "hello all" },
            new Date(now),
          );
          const quiet2 = step(
            quiet,
            other,
            { kind: "talk", text: "hello all" },
            new Date(now),
          );
          same(
            `private then public ${cfg}/${m}`,
            loud2,
            quiet2,
            readers,
            new Date(now + 1000),
          );
          worlds++;
        }
      }
    }
    expect(worlds).toBe(5 * MATCHES * (5 * 3 + 2));
    expect(compared).toBeGreaterThan(1000);
  });
});
