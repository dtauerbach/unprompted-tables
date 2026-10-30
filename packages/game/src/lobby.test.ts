import { describe, expect, it } from "vitest";
import {
  dueToStart,
  fillingSince,
  lobbyRules,
  type Seat,
  viewLobby,
} from "./lobby";

const at = (s: number) => new Date(Date.UTC(2026, 9, 30, 0, 0, s));
const seat = (player: string, joined: number, expires = 1000): Seat => ({
  player,
  joined_at: at(joined),
  expires_at: at(expires),
});
const mafia = lobbyRules({
  min_players: 5,
  max_players: 9,
  fill_seconds: 120,
  hold_seconds: 180,
});
const seats = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => seat(`p${i + from}`, i + from));

describe("lobby template", () => {
  it("waits below the minimum, with no start time and no timer", () => {
    expect(fillingSince(mafia, seats(4), at(4), null)).toBeNull();
    expect(viewLobby(mafia, seats(4), at(500), null).starts_at).toBeNull();
    expect(dueToStart(mafia, seats(4), at(999), null)).toBeNull();
  });

  it("starts the fill timer when the minimum is first seated", () => {
    const lobby = seats(5);
    const since = fillingSince(mafia, lobby, at(4), null);
    expect(since).toEqual(at(4));
    expect(viewLobby(mafia, lobby, at(10), since).starts_at).toEqual(at(124));
    expect(dueToStart(mafia, lobby, at(123), since)).toBeNull();
    expect(dueToStart(mafia, lobby, at(124), since)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("keeps the timer when a seat empties and fills again, so leaving and rejoining can't hold the lobby back", () => {
    const since = at(4);
    // p4 leaves: below the minimum, so no start, but the timer stays.
    const four = seats(4);
    expect(fillingSince(mafia, four, at(60), since)).toEqual(since);
    expect(viewLobby(mafia, four, at(60), since).starts_at).toBeNull();
    // p4 joins again at the back; the lobby starts on the old timer.
    const back = [...four, seat("p4", 61)];
    expect(fillingSince(mafia, back, at(61), since)).toEqual(since);
    expect(viewLobby(mafia, back, at(61), since).starts_at).toEqual(at(124));
    expect(dueToStart(mafia, back, at(124), since)).toHaveLength(5);
  });

  it("drops the timer once the lobby is empty", () => {
    expect(fillingSince(mafia, [], at(60), at(4))).toBeNull();
    const lapsed = seats(5).map((s) => ({ ...s, expires_at: at(50) }));
    expect(fillingSince(mafia, lapsed, at(60), at(4))).toBeNull();
  });

  it("starts at once when full, taking the earliest max_players", () => {
    const lobby = seats(10).reverse();
    expect(viewLobby(mafia, lobby, at(9), at(4)).starts_at).toEqual(at(9));
    expect(dueToStart(mafia, lobby, at(9), at(4))).toEqual(
      Array.from({ length: 9 }, (_, i) => `p${i}`),
    );
  });

  it("starts a full lobby whatever the clocks say", () => {
    // A timer stamped by a clock running ahead of this one, or none at all.
    expect(dueToStart(mafia, seats(9), at(0), at(500))).toHaveLength(9);
    expect(dueToStart(mafia, seats(9), at(0), null)).toHaveLength(9);
  });

  it("counts only seats still held, so a lapsed seat is never dealt in", () => {
    const lobby = [seat("gone", 0, 50), ...seats(5, 1)];
    const since = at(4);
    expect(viewLobby(mafia, lobby, at(10), since).seated).toHaveLength(6);
    expect(viewLobby(mafia, lobby, at(60), since).seated).toHaveLength(5);
    expect(dueToStart(mafia, lobby, at(124), since)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
  });

  it("drops below the minimum when seats lapse, and doesn't start", () => {
    const lobby = [...seats(4), seat("late", 4, 100)];
    expect(dueToStart(mafia, lobby, at(124), at(4))).toBeNull();
    expect(viewLobby(mafia, lobby, at(124), at(4)).seated).toHaveLength(4);
  });

  it("breaks join-time ties by handle so every server agrees", () => {
    const lobby = [seat("b", 0), seat("a", 0)];
    const pair = lobbyRules({
      min_players: 2,
      max_players: 2,
      fill_seconds: 0,
      hold_seconds: 60,
    });
    expect(dueToStart(pair, lobby, at(0), null)).toEqual(["a", "b"]);
  });

  it("pairs at once when min and max are both two", () => {
    const pair = lobbyRules({
      min_players: 2,
      max_players: 2,
      fill_seconds: 600,
      hold_seconds: 60,
    });
    expect(dueToStart(pair, seats(1), at(1), null)).toBeNull();
    expect(dueToStart(pair, seats(2), at(1), at(1))).toEqual(["p0", "p1"]);
  });

  it("refuses rules that can't gather a match", () => {
    const base = {
      min_players: 2,
      max_players: 2,
      fill_seconds: 0,
      hold_seconds: 60,
    };
    for (const bad of [
      { min_players: 1, max_players: 1 },
      { min_players: 5, max_players: 4 },
      { hold_seconds: 0 },
      { fill_seconds: -1 },
      { fill_seconds: 1.5 },
    ])
      expect(() => lobbyRules({ ...base, ...bad })).toThrow();
  });
});
