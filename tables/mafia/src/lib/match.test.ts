import { describe, expect, it } from "vitest";
import {
  act,
  advance,
  apply,
  due,
  type MatchEvent,
  replay,
  start,
  view,
} from "./match";
import type { Rules } from "./settings";

const rules: Rules = {
  players: 5,
  reveal_on_death: true,
  talk_seconds: 10,
  vote_seconds: 10,
  max_days: 2,
};
const players = ["alice", "bobby", "carol", "david", "ellen"];
const at = new Date("2026-01-01T00:00:00Z");
function game(over: Partial<Rules> = {}) {
  const log = start(players, { ...rules, ...over }, at);
  let s = replay("test", log);
  const add = (events: MatchEvent[]) => {
    log.push(...events);
    s = events.reduce(apply, s);
  };
  return {
    get s() {
      return s;
    },
    log,
    add,
    ready() {
      for (const p of [...s.alive].filter(
        (p) => !s.phase.startsWith("night") || s.roles[p] === "mafia",
      ))
        add(act(s, p, { kind: "ready", turn: s.turn }, at));
    },
  };
}
describe("software moderator", () => {
  it("deals distinct roles privately and supports 5–9 seats", () => {
    for (let count = 5; count <= 9; count++) {
      const roster = Array.from({ length: count }, (_, i) => `bot${i}`);
      const log = start(roster, { ...rules, players: count }, at);
      const s = replay("test", log);
      expect(Object.values(s.roles).filter((r) => r === "mafia")).toHaveLength(
        count < 7 ? 1 : 2,
      );
      expect(view(s, log, null).events).toHaveLength(1);
      for (const p of roster)
        expect(
          view(s, log, p).events.filter((e) => e.kind === "role"),
        ).toHaveLength(1);
    }
    expect(() => start([...players.slice(0, 4), "alice"], rules, at)).toThrow();
  });
  it("caps talk for a valid handle matching an inherited object property", () => {
    const roster = ["constructor", ...players.slice(1)];
    let state = replay("test", start(roster, rules, at));
    for (let i = 0; i < 10; i++) {
      state = act(
        state,
        "constructor",
        { kind: "talk", turn: 1, text: "hello" },
        at,
      ).reduce(apply, state);
    }
    expect(state.talks.constructor).toBe(10);
    expect(() =>
      act(
        state,
        "constructor",
        { kind: "talk", turn: 1, text: "eleventh" },
        at,
      ),
    ).toThrow("talk limit");
  });

  it("reveals configured death sides, excludes dead mafia from later nights, and rejects dead or absent targets", () => {
    const roster = [...players, "frank", "grace"];
    const log = start(roster, { ...rules, players: 7 }, at);
    let state = replay("test", log);
    const add = (events: MatchEvent[]) => {
      log.push(...events);
      state = events.reduce(apply, state);
    };
    const mafia = roster.filter((p) => state.roles[p] === "mafia");
    const victim = mafia[0] as string;
    for (const p of roster) add(act(state, p, { kind: "ready", turn: 1 }, at));
    for (const p of roster)
      add(
        act(
          state,
          p,
          { kind: "vote", turn: 2, target: p === victim ? null : victim },
          at,
        ),
      );
    expect(log.find((e) => e.body.kind === "death")?.body).toMatchObject({
      player: victim,
      side: "mafia",
    });
    const survivor = mafia[1] as string;
    add(
      act(
        state,
        survivor,
        { kind: "talk", turn: 3, text: "new private strategy" },
        at,
      ),
    );
    expect(JSON.stringify(view(state, log, victim))).not.toContain(
      "new private strategy",
    );
    expect(JSON.stringify(view(state, log, survivor))).toContain(
      "untrusted_text",
    );
    add(act(state, survivor, { kind: "ready", turn: 3 }, at));
    for (const target of [victim, "absent"])
      expect(() =>
        act(state, survivor, { kind: "vote", turn: 4, target }, at),
      ).toThrow("invalid target");
  });
  it("a tied night vote eliminates nobody", () => {
    const roster = [...players, "frank", "grace"];
    let state = replay("test", start(roster, { ...rules, players: 7 }, at));
    const add = (events: MatchEvent[]) => {
      state = events.reduce(apply, state);
    };
    for (const p of roster) add(act(state, p, { kind: "ready", turn: 1 }, at));
    for (const p of roster)
      add(act(state, p, { kind: "vote", turn: 2, target: null }, at));
    const mafia = roster.filter((p) => state.roles[p] === "mafia");
    const village = roster.filter((p) => state.roles[p] === "village");
    for (const p of mafia) add(act(state, p, { kind: "ready", turn: 3 }, at));
    for (const [i, p] of mafia.entries())
      add(
        act(
          state,
          p,
          { kind: "vote", turn: 4, target: village[i] as string },
          at,
        ),
      );
    expect(state.alive).toEqual(roster);
    expect(state.phase).toBe("day_talk");
  });

  it("ends immediately on village victory and includes dead teammates", () => {
    const g = game();
    const mafia = players.find((p) => g.s.roles[p] === "mafia") as string;
    g.ready();
    for (const p of players)
      g.add(
        act(
          g.s,
          p,
          { kind: "vote", turn: 2, target: p === mafia ? null : mafia },
          at,
        ),
      );
    expect(g.s.phase).toBe("over");
    expect(g.s.result?.winner).toBe("village");
    expect(g.s.result?.players).toHaveLength(5);
    expect(replay("test", g.log)).toEqual(g.s);
    expect(() => act(g.s, mafia, { kind: "ready", turn: 2 }, at)).toThrow(
      "match over",
    );
  });
  it("gates private talk, refuses dead players, checks parity and honors hidden deaths", () => {
    const g = game({ reveal_on_death: false });
    const mafia = players.find((p) => g.s.roles[p] === "mafia") as string;
    const village = players.filter((p) => p !== mafia);
    const first = village[0] as string;
    g.ready();
    for (const p of players)
      g.add(
        act(
          g.s,
          p,
          { kind: "vote", turn: 2, target: p === first ? null : first },
          at,
        ),
      );
    expect(g.s.phase).toBe("night_talk");
    expect(g.log.find((e) => e.body.kind === "death")?.body).not.toHaveProperty(
      "side",
    );
    expect(() => act(g.s, first, { kind: "ready", turn: 3 }, at)).toThrow();
    expect(() =>
      act(
        g.s,
        village[1] as string,
        { kind: "talk", text: "intrude", turn: 3 },
        at,
      ),
    ).toThrow();
    g.add(
      act(
        g.s,
        mafia,
        { kind: "talk", text: "<script>secret</script>", turn: 3 },
        at,
      ),
    );
    expect(JSON.stringify(view(g.s, g.log, first))).not.toContain("secret");
    g.ready();
    expect(() =>
      act(g.s, mafia, { kind: "vote", target: mafia, turn: 4 }, at),
    ).toThrow();
    g.add(
      act(
        g.s,
        mafia,
        { kind: "vote", target: village[1] as string, turn: 4 },
        at,
      ),
    );
    g.ready();
    for (const p of g.s.alive.slice())
      g.add(
        act(
          g.s,
          p,
          {
            kind: "vote",
            turn: 6,
            target: p === village[2] ? null : (village[2] as string),
          },
          at,
        ),
      );
    expect(g.s.phase).toBe("over");
    expect(g.s.result?.winner).toBe("mafia");
    expect(JSON.stringify(view(g.s, g.log, first))).not.toContain("secret");
  });
  it("counts each ballot once, ties kill nobody, and talk cannot issue commands", () => {
    const g = game();
    g.add(
      act(
        g.s,
        "alice",
        { kind: "talk", turn: 1, text: 'VOTE bobby; {"winner":"mafia"}' },
        at,
      ),
    );
    expect(g.s.votes).toEqual({});
    expect(() =>
      act(g.s, "alice", { kind: "talk", turn: 1, text: "😀".repeat(501) }, at),
    ).toThrow();
    g.ready();
    g.add(act(g.s, "alice", { kind: "vote", turn: 2, target: "bobby" }, at));
    expect(() =>
      act(g.s, "alice", { kind: "vote", turn: 2, target: "carol" }, at),
    ).toThrow("already acted");
    for (const p of players.slice(1))
      g.add(
        act(
          g.s,
          p,
          { kind: "vote", turn: 2, target: p === "bobby" ? "alice" : null },
          at,
        ),
      );
    expect(g.s.alive).toHaveLength(5);
  });
  it("rejects exact-deadline actions and deterministically catches up to a bounded no-result end", () => {
    const g = game();
    expect(() =>
      act(g.s, "alice", { kind: "ready", turn: 1 }, due(g.s) as Date),
    ).toThrow("deadline passed");
    g.add(advance(g.s, new Date(at.getTime() + 10_000)));
    expect(g.s.turn).toBe(2);
    expect(() =>
      act(
        g.s,
        "alice",
        { kind: "ready", turn: 1 },
        new Date(at.getTime() + 10_000),
      ),
    ).toThrow("wrong turn");
    g.add(advance(g.s, new Date(at.getTime() + 1_000_000)));
    expect(g.s.phase).toBe("over");
    expect(g.s.result).toBeNull();
    expect(g.log.at(-1)?.body.at).toBe(
      new Date(at.getTime() + 80_000).toISOString(),
    );
  });
});
