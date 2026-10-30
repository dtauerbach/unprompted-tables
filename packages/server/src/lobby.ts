import {
  dueToStart,
  type LobbyRules,
  type LobbyView,
  type Seat,
  viewLobby,
} from "@unprompted-tables/game";
import { db, type Tx } from "./db";
import { consume, type Rule } from "./limits";

// A Table that uses the lobby template keeps its seats in a table named
// queue (player, joined_at, expires_at), and holds its own lobby lock, the
// lock argument here, around every change to it. One lobby at a time, so
// two joins at once can't both claim the same seats.

export async function lockLobby(tx: Tx, lock: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(${lock})`;
}

async function liveSeats(tx: Tx, at: Date): Promise<Seat[]> {
  return tx<Seat[]>`
    SELECT player, joined_at, expires_at FROM queue WHERE expires_at > ${at}`;
}

// Take a seat, or keep one. A seat still held keeps its place in line; one
// that lapsed goes to the back, as if new.
export async function holdSeat(
  tx: Tx,
  rules: LobbyRules,
  player: string,
  at: Date,
): Promise<Date> {
  const until = new Date(at.getTime() + rules.hold_seconds * 1000);
  await tx`
    INSERT INTO queue (player, joined_at, expires_at)
    VALUES (${player}, ${at}, ${until})
    ON CONFLICT (player) DO UPDATE SET
      joined_at = CASE WHEN queue.expires_at > ${at}
        THEN queue.joined_at ELSE EXCLUDED.joined_at END,
      expires_at = EXCLUDED.expires_at`;
  return until;
}

// Checking in keeps a seat that is still held. A lapsed seat stays lapsed:
// only joining again takes a new one.
export async function checkIn(
  tx: Tx,
  rules: LobbyRules,
  player: string,
  at: Date,
): Promise<Date | null> {
  const until = new Date(at.getTime() + rules.hold_seconds * 1000);
  const [row] = await tx<{ expires_at: Date }[]>`
    UPDATE queue SET expires_at = ${until}
    WHERE player = ${player} AND expires_at > ${at}
    RETURNING expires_at`;
  return row?.expires_at ?? null;
}

// If the lobby is due, take its players out of it and return them for the
// Table to start a match with.
export async function takeDue(
  tx: Tx,
  rules: LobbyRules,
  at: Date,
): Promise<string[] | null> {
  const players = dueToStart(rules, await liveSeats(tx, at), at);
  if (players) await tx`DELETE FROM queue WHERE player = ANY(${players})`;
  return players;
}

export async function readLobby(
  tx: Tx,
  rules: LobbyRules,
  at: Date,
): Promise<LobbyView> {
  return viewLobby(rules, await liveSeats(tx, at), at);
}

// What a Table shows of its lobby: the rules, who is seated and when it
// starts. Seats are public, like the players of a match.
export function publicLobby(rules: LobbyRules, view: LobbyView) {
  return {
    ...rules,
    seated: view.seated.map((s) => s.player),
    starts_at: view.starts_at?.toISOString() ?? null,
  };
}

export type Standing =
  | { status: "playing"; match: string }
  | { status: "waiting"; until: Date; lobby: ReturnType<typeof publicLobby> }
  | { status: "idle" };

// What a Table hands the lobby: its rules and lock, its clock, and how it
// finds, brings up to date and starts its matches.
export type LobbyTable = {
  rules: LobbyRules;
  lock: number;
  now: () => Date;
  joinRules: (player: string) => Rule[];
  openMatchOf: (tx: Tx, player: string) => Promise<string | null>;
  settleMatch: (match: string) => Promise<void>;
  startMatch: (tx: Tx, players: string[]) => Promise<string>;
};

// The queue endpoints of a Table that seats players through the lobby. A
// player takes a seat, keeps it by checking in, and is in at most one match
// at a time. Checking in also starts the match the lobby is due for, so a
// lobby fills and starts while its players wait, with nothing running in
// the background.
export function lobbyQueue(t: LobbyTable) {
  // A match whose time ran out while nobody looked still counts as open
  // until its clock is brought up to date, so do that first.
  async function settle(player: string): Promise<void> {
    const open = await db().begin((tx) => t.openMatchOf(tx, player));
    if (open) await t.settleMatch(open);
  }

  async function startDue(tx: Tx): Promise<void> {
    const players = await takeDue(tx, t.rules, t.now());
    if (players) await t.startMatch(tx, players);
  }

  async function standingIn(tx: Tx, player: string): Promise<Standing> {
    const current = await t.openMatchOf(tx, player);
    if (current) return { status: "playing", match: current };
    const view = await readLobby(tx, t.rules, t.now());
    const seat = view.seated.find((s) => s.player === player);
    return seat
      ? {
          status: "waiting",
          until: seat.expires_at,
          lobby: publicLobby(t.rules, view),
        }
      : { status: "idle" };
  }

  return {
    async joinQueue(player: string): Promise<Standing> {
      await settle(player);
      return db().begin(async (tx) => {
        await lockLobby(tx, t.lock);
        const current = await t.openMatchOf(tx, player);
        if (current) return { status: "playing", match: current };
        await consume(tx, t.joinRules(player));
        await holdSeat(tx, t.rules, player, t.now());
        await startDue(tx);
        return standingIn(tx, player);
      });
    },

    async leaveQueue(player: string): Promise<void> {
      await db().begin(async (tx) => {
        // The lobby may already have taken this seat for a match. Leaving
        // waits for that, so it can't say idle before the match exists.
        await lockLobby(tx, t.lock);
        await tx`DELETE FROM queue WHERE player = ${player}`;
      });
    },

    async standingOf(player: string, writable: boolean): Promise<Standing> {
      if (writable) await settle(player);
      return db().begin(async (tx) => {
        if (writable) {
          const [seated] = await tx`
            SELECT 1 FROM queue
            WHERE player = ${player} AND expires_at > ${t.now()}`;
          if (seated) {
            await lockLobby(tx, t.lock);
            await checkIn(tx, t.rules, player, t.now());
            await startDue(tx);
          }
        }
        return standingIn(tx, player);
      });
    },

    async lobby() {
      return db().begin(async (tx) =>
        publicLobby(t.rules, await readLobby(tx, t.rules, t.now())),
      );
    },
  };
}
