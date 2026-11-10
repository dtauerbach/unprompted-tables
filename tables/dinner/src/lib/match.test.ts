import { describe, expect, it } from "vitest";
import { briefFor, conflicted, deal } from "./deal";
import {
  act,
  advance,
  apply,
  type MatchEvent,
  type MatchState,
  replay,
  start,
  view,
} from "./match";
import { rng } from "./rng";
import { bounds, canonical, report, scores, seatings } from "./score";
import { VARIANTS, type Variant, variantSchema } from "./variants";

const players = ["alice", "bobby", "carol", "david", "ellen", "frank"];
const T0 = new Date("2026-11-10T03:00:00.000Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);
const quick = VARIANTS.quick as Variant;

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "ok";
};

// Whether a text shows up anywhere in what a reader gets. Compares the JSON
// forms, since a brief has newlines that JSON writes as \n.
const shows = (body: unknown, text: string) =>
  JSON.stringify(body).includes(JSON.stringify(text).slice(1, -1));

function party(variant: Variant = quick, seed = "42") {
  let events = start(players, variant, T0, seed);
  let state = replay("m_abcdefghijkl", events);
  const run = (player: string, action: Parameters<typeof act>[2], at = 1) => {
    const added = act(state, player, action, later(at));
    events = [...events, ...added];
    state = added.reduce(apply, state);
    return added;
  };
  const tick = (at: number) => {
    const added = advance(state, later(at));
    events = [...events, ...added];
    state = added.reduce(apply, state);
    return added;
  };
  return {
    run,
    tick,
    get state(): MatchState {
      return state;
    },
    get events(): MatchEvent[] {
      return events;
    },
  };
}

describe("scoring", () => {
  it("lists every seating once up to rotation", () => {
    const all = [...seatings(5)];
    expect(all).toHaveLength(24);
    expect(new Set(all.map((s) => s.join())).size).toBe(24);
    expect(all.every((s) => s[0] === 0)).toBe(true);
  });

  it("scores neighbours round the table, last beside first", () => {
    const feel = [
      [0, 3, 0, -3],
      [1, 0, 0, 0],
      [0, 0, 0, 2],
      [0, 0, 0, 0],
    ];
    expect(scores(feel, [0, 1, 2, 3])).toEqual([0, 1, 2, 0]);
  });

  it("finds the fairest and the biggest seatings exactly", () => {
    // Everyone loves 0; 0 can sit by only two.
    const feel = [
      [0, 1, 1, 1],
      [3, 0, 0, 0],
      [3, 0, 0, 0],
      [3, 0, 0, 0],
    ];
    const b = bounds(feel);
    expect(b.best).toEqual([2, 3, 3, 3]);
    expect(b.worst).toEqual([2, 0, 0, 0]);
    expect(b.fairest_floor).toBe(0);
    const r = report(feel, [0, 1, 2, 3]);
    expect(r.scores).toEqual([2, 3, 0, 3]);
    expect(r.worst_off).toBe(0);
    expect(r.value_captured).toBe(1);
  });

  it("counts pairs who'd both gain by trading seats", () => {
    // 0 wants 2's spot by 2, 1 wants 0's spot by 3: trading helps both.
    const feel = [
      [0, 0, 5, 0],
      [0, 0, 0, 5],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    expect(report(feel, [0, 1, 2, 3]).swaps).toEqual([[0, 1]]);
    // Once they've traded, nobody gains.
    expect(report(feel, [1, 0, 2, 3]).swaps).toEqual([]);
  });

  it("treats rotations and reflections as one seating", () => {
    expect(canonical([0, 1, 2, 3])).toBe(canonical([2, 3, 0, 1]));
    expect(canonical([0, 1, 2, 3])).toBe(canonical([0, 3, 2, 1]));
    expect(canonical([0, 1, 2, 3])).not.toBe(canonical([0, 2, 1, 3]));
  });
});

describe("dealing", () => {
  it("deals the same hand from the same seed and a conflicted one", () => {
    const a = deal(6, quick, "7");
    expect(deal(6, quick, "7")).toEqual(a);
    expect(new Set(a.guests).size).toBe(6);
    expect(conflicted(a.feel)).toBe(true);
    for (let seed = 0; seed < 30; seed++)
      expect(
        conflicted(deal(5, quick, String(seed)).feel),
        `seed ${seed}`,
      ).toBe(true);
  });

  it("gives each guest favourites, an avoid and an unrequited love", () => {
    const d = deal(8, quick, "3");
    d.feel.forEach((row, i) => {
      expect(row[i]).toBe(0);
      expect(
        row.filter((v) => v === quick.brief.love).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        row.filter((v) => v === quick.brief.avoid).length,
      ).toBeGreaterThanOrEqual(1);
    });
    const unrequited = d.feel.some((row, i) =>
      row.some(
        (v, j) =>
          v === quick.brief.love && d.feel[j]?.[i] === quick.brief.avoid,
      ),
    );
    expect(unrequited).toBe(true);
  });

  it("writes a brief with exact numbers and keeps secrets quiet", () => {
    const d = deal(6, quick, "11");
    const b = briefFor(d, 0);
    expect(b.text).toContain(`You are ${d.guests[0]}`);
    expect(Object.keys(b.feelings)).toHaveLength(5);
    expect(b.feelings).not.toHaveProperty(d.guests[0] as string);
    const hasSecret = d.secret.some((row) => row.some(Boolean));
    if (hasSecret) {
      const i = d.secret.findIndex((row) => row.some(Boolean));
      expect(briefFor(d, i).text).toContain("don't say why");
    }
  });

  it("draws from a 128-bit seed, the shown and private draws apart", () => {
    const events = start(players, quick, T0);
    const d = (
      events.find((e) => e.body.kind === "deal")?.body as {
        deal: { seed: string };
      }
    ).deal;
    expect(d.seed).toMatch(/^[0-9a-f]{32}$/);
    const a = rng("s", "guests");
    const b = rng("s", "feelings");
    const xs = Array.from({ length: 20 }, a);
    expect(Array.from({ length: 20 }, b)).not.toEqual(xs);
    expect(Array.from({ length: 20 }, rng("s", "guests"))).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("checks every variant and refuses a broken one", () => {
    for (const v of Object.values(VARIANTS))
      expect(variantSchema.safeParse(v).success).toBe(true);
    expect(
      variantSchema.safeParse({
        ...quick,
        lock: { consensus: "all", fallback: ["most_backed"] },
      }).success,
    ).toBe(false);
    // A full party's moves must all fit what watchers see.
    expect(
      variantSchema.safeParse({
        ...quick,
        messages_per_guest: 200,
        backs_per_guest: 200,
      }).success,
    ).toBe(false);
    expect(variantSchema.safeParse({ ...quick, talk_seconds: 1 }).success).toBe(
      false,
    );
  });
});

describe("a party", () => {
  it("keeps briefs private and the deal from everyone", () => {
    const p = party();
    const outsider = JSON.stringify(view(p.state, p.events, null));
    const alice = view(p.state, p.events, "alice");
    expect(alice.you?.brief).toContain("You are");
    expect(outsider).not.toContain("You are");
    expect(outsider).not.toContain("feelings");
    const d = p.state.deal;
    expect(d).not.toBeNull();
    expect(JSON.stringify(alice)).not.toContain(`"seed"`);
    const briefs = players.map(
      (who) => view(p.state, p.events, who).you?.brief as string,
    );
    expect(new Set(briefs).size).toBe(players.length);
    expect(shows(alice, briefs[0] as string)).toBe(true);
    players.forEach((who, i) => {
      const seen = view(p.state, p.events, who);
      briefs.forEach((b, j) => {
        if (i !== j)
          expect(shows(seen, b), `${who} sees brief ${j}`).toBe(false);
      });
    });
    for (const b of briefs) expect(shows(JSON.parse(outsider), b)).toBe(false);
  });

  it("locks as soon as everyone backs one plan", () => {
    const p = party();
    const guests = p.state.guests;
    p.run("alice", { kind: "propose", seating: guests });
    for (const who of players.slice(1, -1))
      expect(p.run(who, { kind: "back", proposal: "P1" })).toHaveLength(1);
    const last = p.run("frank", { kind: "back", proposal: "P1" });
    expect(last.map((e) => e.body.kind)).toEqual(["back", "end"]);
    expect(p.state.phase).toBe("over");
    expect(p.state.end?.how).toBe("consensus");
    expect(p.state.end?.seating).toEqual(guests);
    expect(() => p.run("alice", { kind: "talk", text: "hi" })).toThrow(
      "match over",
    );
    const after = view(p.state, p.events, null);
    expect(after.result?.guests[0]?.brief).toContain("You are");
  });

  it("locks on a majority in the majority variant", () => {
    const p = party(VARIANTS.majority as Variant);
    p.run("alice", { kind: "propose", seating: p.state.guests });
    p.run("bobby", { kind: "back", proposal: "P1" });
    expect(p.state.phase).toBe("talk");
    p.run("carol", { kind: "back", proposal: "P1" });
    expect(p.state.phase).toBe("talk");
    p.run("david", { kind: "back", proposal: "P1" });
    expect(p.state.end?.how).toBe("majority");
  });

  it("refuses bad seatings, repeats, outsiders and overlong talk", () => {
    const p = party();
    const g = p.state.guests;
    expect(
      code(() => p.run("alice", { kind: "propose", seating: g.slice(1) })),
    ).toBe("invalid_seating");
    expect(
      code(() =>
        p.run("alice", { kind: "propose", seating: [...g.slice(1), "Zed"] }),
      ),
    ).toBe("invalid_seating");
    expect(
      code(() =>
        p.run("alice", {
          kind: "propose",
          seating: [g[0] as string, ...g.slice(0, -1)],
        }),
      ),
    ).toBe("invalid_seating");
    p.run("alice", { kind: "propose", seating: g });
    const turned = [...g.slice(2), ...g.slice(0, 2)].reverse();
    expect(
      code(() => p.run("bobby", { kind: "propose", seating: turned })),
    ).toBe("already_proposed");
    expect(code(() => p.run("mallory", { kind: "talk", text: "hi" }))).toBe(
      "not_seated",
    );
    expect(code(() => p.run("bobby", { kind: "back", proposal: "P9" }))).toBe(
      "no_such_proposal",
    );
    expect(
      code(() =>
        p.run("bobby", {
          kind: "talk",
          text: "x".repeat(quick.message_chars + 1),
        }),
      ),
    ).toBe("too_long");
    expect(
      code(() => p.run("bobby", { kind: "talk", text: "bad\u0007" })),
    ).toBe("invalid_text");
    expect(code(() => p.run("bobby", { kind: "talk", text: "   " }))).toBe(
      "invalid_text",
    );
    expect(p.run("alice", { kind: "back", proposal: "P1" })).toEqual([]);
    expect(
      code(() =>
        p.run("bobby", { kind: "talk", text: "late" }, quick.talk_seconds),
      ),
    ).toBe("deadline_passed");
  });

  it("caps talk and proposals per guest", () => {
    const v = { ...quick, messages_per_guest: 2, proposals_per_guest: 1 };
    const p = party(v);
    p.run("alice", { kind: "talk", text: "one" });
    p.run("alice", { kind: "talk", text: "two" });
    expect(() => p.run("alice", { kind: "talk", text: "three" })).toThrow();
    const g = p.state.guests;
    p.run("alice", { kind: "propose", seating: g });
    // A different seating, so only the cap can refuse it.
    const other = [g[0], g[2], g[1], ...g.slice(3)] as string[];
    expect(
      code(() => p.run("alice", { kind: "propose", seating: other })),
    ).toBe("proposal_limit");
    expect(p.run("bobby", { kind: "propose", seating: other })).toHaveLength(1);
  });

  it("caps changes of backing per guest", () => {
    const p = party({ ...quick, backs_per_guest: 3 });
    const g = p.state.guests;
    p.run("alice", { kind: "propose", seating: g });
    p.run("bobby", {
      kind: "propose",
      seating: [g[1], g[0], ...g.slice(2)] as string[],
    });
    p.run("carol", { kind: "back", proposal: "P1" });
    p.run("carol", { kind: "back", proposal: "P2" });
    p.run("carol", { kind: "back", proposal: null });
    expect(view(p.state, p.events, "carol").you?.backs_left).toBe(0);
    expect(code(() => p.run("carol", { kind: "back", proposal: "P1" }))).toBe(
      "backing_limit",
    );
    // Asking for what it already backs changes nothing, so it's no refusal.
    expect(p.run("carol", { kind: "back", proposal: null })).toEqual([]);
    expect(p.run("david", { kind: "back", proposal: "P1" })).toHaveLength(1);
  });

  it("falls back to the most backed plan at the deadline", () => {
    const p = party();
    const g = p.state.guests;
    p.run("alice", { kind: "propose", seating: g });
    p.run("bobby", {
      kind: "propose",
      seating: [g[1], g[0], ...g.slice(2)] as string[],
    });
    p.run("carol", { kind: "back", proposal: "P2" });
    expect(p.tick(quick.talk_seconds - 1)).toEqual([]);
    const [end] = p.tick(quick.talk_seconds + 500);
    expect(end?.body.kind).toBe("end");
    expect(p.state.end?.how).toBe("most_backed");
    expect(p.state.end?.proposal).toBe("P2");
    // Closed at the deadline, not when someone happened to look.
    expect(p.state.end?.at).toBe(later(quick.talk_seconds).toISOString());
  });

  it("draws at random on a tie, the same draw every replay", () => {
    const p = party();
    const g = p.state.guests;
    p.run("alice", { kind: "propose", seating: g });
    p.run("bobby", {
      kind: "propose",
      seating: [g[1], g[0], ...g.slice(2)] as string[],
    });
    p.tick(quick.talk_seconds);
    expect(p.state.end?.how).toBe("random");
    const again = replay(p.state.id, p.events);
    expect(again.end?.seating).toEqual(p.state.end?.seating);
    expect(new Set(p.state.end?.seating).size).toBe(6);
    // Drawn from the seed: the same party played again draws the same,
    // and other seeds draw differently.
    const tied = (seed: string) => {
      const q = party(quick, seed);
      const h = q.state.guests;
      q.run("alice", { kind: "propose", seating: h });
      q.run("bobby", {
        kind: "propose",
        seating: [h[1], h[0], ...h.slice(2)] as string[],
      });
      q.tick(quick.talk_seconds);
      expect(q.state.end?.how).toBe("random");
      // By seat, not by name: names differ per seed anyway.
      return (q.state.end?.seating ?? []).map((n) => h.indexOf(n)).join();
    };
    expect(tied("42")).toBe(
      (p.state.end?.seating ?? []).map((n) => g.indexOf(n)).join(),
    );
    const draws = new Set(
      Array.from({ length: 12 }, (_, i) => tied(`other-${i}`)),
    );
    expect(draws.size).toBeGreaterThan(1);
  });

  it("lets the kind host seat everyone fairly when nobody agrees", () => {
    const p = party(VARIANTS["kind-host"] as Variant);
    p.tick(quick.talk_seconds * 20);
    expect(p.state.end?.how).toBe("fairest");
    const r = p.state.end?.report;
    expect(r?.worst_off).toBe(r?.best_worst_off);
  });

  it("moves backing and withdraws it", () => {
    const p = party();
    const g = p.state.guests;
    p.run("alice", { kind: "propose", seating: g });
    p.run("bobby", {
      kind: "propose",
      seating: [g[1], g[0], ...g.slice(2)] as string[],
    });
    p.run("alice", { kind: "back", proposal: "P2" });
    expect(
      view(p.state, p.events, null).proposals.map((x) => x.backers.length),
    ).toEqual([0, 2]);
    p.run("alice", { kind: "back", proposal: null });
    expect(
      view(p.state, p.events, null).proposals.map((x) => x.backers.length),
    ).toEqual([0, 1]);
  });

  it("treats handles like constructor as players, not properties", () => {
    const odd = ["constructor", "__proto__x", "toString", "hasown"];
    const events = start(odd, quick, T0, "5");
    const s = replay("m_abcdefghijkl", events);
    const added = act(
      s,
      "constructor",
      { kind: "talk", text: "hello" },
      later(1),
    );
    const s2 = added.reduce(apply, s);
    expect(
      view(s2, [...events, ...added], "constructor").you?.messages_left,
    ).toBe(quick.messages_per_guest - 1);
  });
});
