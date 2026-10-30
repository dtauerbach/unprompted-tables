// Lobby template. A Table gathers players until it has enough, waits a
// little for more, and starts. A Table may use it with its own numbers or
// gather players its own way; what a match does with them is its rules.

export type LobbyRules = {
  // Fewest players a match can start with, and most it takes.
  min_players: number;
  max_players: number;
  // Once the minimum is seated, how long the lobby waits for more.
  fill_seconds: number;
  // A seat lasts this long after its player last checked in, so a match
  // seats only players who are still there.
  hold_seconds: number;
};

export type Seat = { player: string; joined_at: Date; expires_at: Date };

export type LobbyView = {
  // Live seats, earliest first.
  seated: Seat[];
  // When the lobby starts if nobody leaves; null until the minimum is seated.
  starts_at: Date | null;
};

export function lobbyRules(rules: LobbyRules): LobbyRules {
  const { min_players, max_players, fill_seconds, hold_seconds } = rules;
  for (const [name, n] of Object.entries(rules))
    if (!(Number.isInteger(n) && n >= 0))
      throw new Error(`lobby ${name} needs a whole number`);
  if (min_players < 2) throw new Error("a lobby needs at least two players");
  if (max_players < min_players)
    throw new Error("a lobby's max_players is below its min_players");
  if (hold_seconds < 1) throw new Error("a lobby seat must last a second");
  return { min_players, max_players, fill_seconds, hold_seconds };
}

// Only seats still held count. The timer runs from when the minimum-th
// live seat joined, so a player leaving pushes the start back rather than
// leaving a stale timer behind.
export function viewLobby(
  rules: LobbyRules,
  seats: Seat[],
  at: Date,
): LobbyView {
  const seated = seats
    .filter((s) => s.expires_at > at)
    .sort(
      (a, b) =>
        a.joined_at.getTime() - b.joined_at.getTime() ||
        (a.player < b.player ? -1 : a.player > b.player ? 1 : 0),
    );
  let starts_at: Date | null = null;
  if (seated.length >= rules.max_players)
    starts_at = (seated[rules.max_players - 1] as Seat).joined_at;
  else if (seated.length >= rules.min_players)
    starts_at = new Date(
      (seated[rules.min_players - 1] as Seat).joined_at.getTime() +
        rules.fill_seconds * 1000,
    );
  return { seated, starts_at };
}

// The players to start a match with now, earliest first, or null if the
// lobby isn't due.
export function dueToStart(
  rules: LobbyRules,
  seats: Seat[],
  at: Date,
): string[] | null {
  const { seated, starts_at } = viewLobby(rules, seats, at);
  if (!starts_at || starts_at > at) return null;
  return seated.slice(0, rules.max_players).map((s) => s.player);
}
