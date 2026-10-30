import {
  dueToStart,
  fillingSince,
  type LobbyRules,
  type LobbyView,
  type Seat,
  viewLobby,
} from "@unprompted-tables/game";
import { db, type Tx } from "./db";
import { consume, type Rule } from "./limits";

// A Table that uses the lobby template keeps its seats in a table named
// queue (player, joined_at, expires_at) and its fill timer in a one-row
// table named lobby (id, filling_since), and holds its own lobby lock, the
// lock argument here, around every change to them. One lobby at a time, so
// two joins at once can't both claim the same seats.

export async function lockLobby(tx: Tx, lock: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(${lock})`;
}

async function liveSeats(tx: Tx, at: Date): Promise<Seat[]> {
  return tx<Seat[]>`
    SELECT player, joined_at, expires_at FROM queue WHERE expires_at > ${at}`;
}

async function timer(tx: Tx): Promise<Date | null> {
  const [row] = await tx<{ filling_since: Date | null }[]>`
    SELECT filling_since FROM lobby`;
  return row?.filling_since ?? null;
}

async function setTimer(tx: Tx, since: Date | null): Promise<void> {
  await tx`
    INSERT INTO lobby (id, filling_since) VALUES (true, ${since})
    ON CONFLICT (id) DO UPDATE SET filling_since = EXCLUDED.filling_since`;
}

// Bring the fill timer up to date with the seats. Run before and after
// every change, under the lobby lock: before, so a lobby that emptied while
// nobody looked starts afresh; after, so the change starts the timer.
export async function syncTimer(
  tx: Tx,
  rules: LobbyRules,
  at: Date,
): Promise<void> {
  const before = await timer(tx);
  const since = fillingSince(rules, await liveSeats(tx, at), at, before);
  if (since?.getTime() !== before?.getTime()) await setTimer(tx, since);
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
// Table to start a match with. Whoever is left starts a new lobby.
export async function takeDue(
  tx: Tx,
  rules: LobbyRules,
  at: Date,
): Promise<string[] | null> {
  const players = dueToStart(
    rules,
    await liveSeats(tx, at),
    at,
    await timer(tx),
  );
  if (!players) return null;
  await tx`DELETE FROM queue WHERE player = ANY(${players})`;
  await setTimer(tx, null);
  await syncTimer(tx, rules, at);
  return players;
}

export async function readLobby(
  tx: Tx,
  rules: LobbyRules,
  at: Date,
): Promise<LobbyView> {
  return viewLobby(rules, await liveSeats(tx, at), at, await timer(tx));
}

// Seats whose time ran out, gone for good. Under the lock, like any other
// change to the lobby, with the timer brought up to date after.
export async function sweepLobby(
  tx: Tx,
  lock: number,
  rules: LobbyRules,
  at: Date,
): Promise<void> {
  await lockLobby(tx, lock);
  await tx`DELETE FROM queue WHERE expires_at <= ${at}`;
  await syncTimer(tx, rules, at);
}

// What a Table shows of its lobby: the rules, who is seated, how many more
// players it needs before it can start, and when it starts. Seats are
// public, like the players of a match.
export function publicLobby(rules: LobbyRules, view: LobbyView) {
  return {
    ...rules,
    seated: view.seated.map((s) => s.player),
    needed: Math.max(0, rules.min_players - view.seated.length),
    starts_at: view.starts_at?.toISOString() ?? null,
  };
}

export type Standing =
  | { status: "playing"; match: string }
  | { status: "waiting"; until: Date; lobby: ReturnType<typeof publicLobby> }
  | { status: "idle" };

// What a Table hands the lobby: its rules and lock, its clock, and how it
// finds, brings up to date and starts its matches. The clock is read from
// the database, so every server running the Table stamps seats alike.
export type LobbyTable = {
  rules: LobbyRules;
  lock: number;
  now: (tx: Tx) => Promise<Date>;
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

  // Every change to the lobby, under its lock: the timer brought up to date
  // on both sides of it, then whatever match is due started.
  async function change(
    tx: Tx,
    at: Date,
    what: () => Promise<unknown>,
  ): Promise<void> {
    await syncTimer(tx, t.rules, at);
    await what();
    await syncTimer(tx, t.rules, at);
    const players = await takeDue(tx, t.rules, at);
    if (players) await t.startMatch(tx, players);
  }

  async function standingIn(tx: Tx, player: string, at: Date) {
    const current = await t.openMatchOf(tx, player);
    if (current) return { status: "playing", match: current } as const;
    const view = await readLobby(tx, t.rules, at);
    const seat = view.seated.find((s) => s.player === player);
    return seat
      ? ({
          status: "waiting",
          until: seat.expires_at,
          lobby: publicLobby(t.rules, view),
        } as const)
      : ({ status: "idle" } as const);
  }

  return {
    async joinQueue(player: string): Promise<Standing> {
      await settle(player);
      return db().begin(async (tx) => {
        const at = await t.now(tx);
        await lockLobby(tx, t.lock);
        const current = await t.openMatchOf(tx, player);
        if (current) return { status: "playing", match: current };
        await consume(tx, t.joinRules(player));
        await change(tx, at, () => holdSeat(tx, t.rules, player, at));
        return standingIn(tx, player, at);
      });
    },

    async leaveQueue(player: string): Promise<void> {
      await db().begin(async (tx) => {
        // The lobby may already have taken this seat for a match. Leaving
        // waits for that, so it can't say idle before the match exists.
        const at = await t.now(tx);
        await lockLobby(tx, t.lock);
        await change(
          tx,
          at,
          () => tx`DELETE FROM queue WHERE player = ${player}`,
        );
      });
    },

    // Checking in writes only when it matters: when the seat is past half
    // its time, or the lobby is due. A player polling every few seconds
    // doesn't take the lock each time.
    async standingOf(player: string, writable: boolean): Promise<Standing> {
      if (writable) await settle(player);
      return db().begin(async (tx) => {
        const at = await t.now(tx);
        if (writable) {
          const seats = await liveSeats(tx, at);
          const seat = seats.find((s) => s.player === player);
          const fresh =
            seat &&
            seat.expires_at.getTime() - at.getTime() >
              (t.rules.hold_seconds * 1000) / 2;
          if (
            seat &&
            (!fresh || dueToStart(t.rules, seats, at, await timer(tx)))
          ) {
            await lockLobby(tx, t.lock);
            await change(tx, at, () => checkIn(tx, t.rules, player, at));
          }
        }
        return standingIn(tx, player, at);
      });
    },

    async lobby() {
      return db().begin(async (tx) =>
        publicLobby(t.rules, await readLobby(tx, t.rules, await t.now(tx))),
      );
    },
  };
}
