import { describe, expect, it } from "vitest";
import { dueToStart, lobbyRules, type Seat, viewLobby } from "./lobby";

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
  it("waits below the minimum, with no start time", () => {
    expect(viewLobby(mafia, seats(4), at(500)).starts_at).toBeNull();
    expect(dueToStart(mafia, seats(4), at(999))).toBeNull();
  });

  it("starts the fill timer when the minimum-th player joins", () => {
    const lobby = seats(5);
    expect(viewLobby(mafia, lobby, at(10)).starts_at).toEqual(at(124));
    expect(dueToStart(mafia, lobby, at(123))).toBeNull();
    expect(dueToStart(mafia, lobby, at(124))).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("starts at once when full, taking the earliest max_players", () => {
    const lobby = seats(10).reverse();
    expect(viewLobby(mafia, lobby, at(9)).starts_at).toEqual(at(8));
    expect(dueToStart(mafia, lobby, at(9))).toEqual(
      Array.from({ length: 9 }, (_, i) => `p${i}`),
    );
  });

  it("counts only seats still held, so a lapsed seat pushes the start back", () => {
    const lobby = [seat("gone", 0, 50), ...seats(5, 1)];
    expect(viewLobby(mafia, lobby, at(10)).starts_at).toEqual(at(124));
    // After "gone" lapses, the fifth live seat is p5, so the timer runs
    // from its join and "gone" is never seated.
    expect(viewLobby(mafia, lobby, at(60)).starts_at).toEqual(at(125));
    expect(dueToStart(mafia, lobby, at(125))).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
  });

  it("drops below the minimum when seats lapse, and doesn't start", () => {
    const lobby = [...seats(4), seat("late", 4, 100)];
    expect(dueToStart(mafia, lobby, at(124))).toBeNull();
    expect(viewLobby(mafia, lobby, at(124)).seated).toHaveLength(4);
  });

  it("breaks join-time ties by handle so every server agrees", () => {
    const lobby = [seat("b", 0), seat("a", 0)];
    const pair = lobbyRules({
      min_players: 2,
      max_players: 2,
      fill_seconds: 0,
      hold_seconds: 60,
    });
    expect(dueToStart(pair, lobby, at(0))).toEqual(["a", "b"]);
  });

  it("pairs at once when min and max are both two", () => {
    const pair = lobbyRules({
      min_players: 2,
      max_players: 2,
      fill_seconds: 600,
      hold_seconds: 60,
    });
    expect(dueToStart(pair, seats(1), at(1))).toBeNull();
    expect(dueToStart(pair, seats(2), at(1))).toEqual(["p0", "p1"]);
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
