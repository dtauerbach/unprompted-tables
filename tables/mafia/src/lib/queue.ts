import { consume, db } from "@unprompted-tables/server";
import { now } from "./clock";
import { queueRules } from "./limits";
import { QUEUE_LOCK, SETTINGS } from "./settings";
import { openMatchOf, startMatch, withMatch } from "./store";

// Pairing: a player joins the queue and is matched with whoever has waited
// longest, or waits for the next to join. A player is in at most one match
// at a time, and never against itself.

export type Standing =
  | { status: "playing"; match: string }
  | { status: "waiting"; until: Date }
  | { status: "idle" };

// A match whose time ran out while nobody looked still counts as open until
// its clock is brought up to date, so do that first.
async function settle(player: string): Promise<void> {
  const open = await db().begin((tx) => openMatchOf(tx, player));
  if (open) await withMatch(open, async () => ({ events: [], value: null }));
}

export async function joinQueue(player: string): Promise<Standing> {
  await settle(player);
  return db().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`;
    const current = await openMatchOf(tx, player);
    if (current) return { status: "playing", match: current };
    await consume(tx, queueRules(player));
    const others = await tx<{ player: string }[]>`
      SELECT player FROM queue
      WHERE player <> ${player} AND expires_at > ${now()}
      ORDER BY joined_at, player LIMIT ${SETTINGS.players - 1}`;
    if (others.length === SETTINGS.players - 1) {
      const players = [...others.map((row) => row.player), player];
      await tx`DELETE FROM queue WHERE player = ANY(${players})`;
      const match = await startMatch(tx, players);
      return { status: "playing", match };
    }
    const until = new Date(now().getTime() + SETTINGS.queue_seconds * 1000);
    await tx`
      INSERT INTO queue (player, joined_at, expires_at)
      VALUES (${player}, ${now()}, ${until})
      ON CONFLICT (player) DO UPDATE SET expires_at = EXCLUDED.expires_at`;
    return { status: "waiting", until };
  });
}

export async function leaveQueue(player: string): Promise<void> {
  await db().begin(async (tx) => {
    // Matchmaking may already have selected this seat. Leave must serialize
    // with that selection so a successful idle response cannot precede pairing.
    await tx`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`;
    await tx`DELETE FROM queue WHERE player = ${player}`;
  });
}

export async function standingOf(
  player: string,
  writable: boolean,
): Promise<Standing> {
  if (writable) await settle(player);
  return db().begin(async (tx) => {
    const current = await openMatchOf(tx, player);
    if (current) return { status: "playing", match: current };
    const [row] = await tx<{ expires_at: Date }[]>`
      SELECT expires_at FROM queue
      WHERE player = ${player} AND expires_at > ${now()}`;
    return row
      ? { status: "waiting", until: row.expires_at }
      : { status: "idle" };
  });
}
