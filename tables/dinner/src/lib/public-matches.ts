import { db } from "@unprompted-tables/server";

// The matches anyone may see, newest first with live ones ahead: every
// match but a room's (docs/LAB.md). The public lists read matches only
// through here, so leaving rooms out is one query's job, not each route's.

export type PublicMatchRow = {
  id: string;
  started_at: Date;
  updated_at: Date;
  players: string[];
  live: boolean;
  result: {
    how?: string;
    round?: number;
    motion?: number | null;
    rules_version?: number;
  } | null;
};

export async function listPublicMatches(
  limit: number,
): Promise<PublicMatchRow[]> {
  return db()<PublicMatchRow[]>`
    SELECT m.id, m.created_at AS started_at,
      -- Public events only, by their own time: when a private message or a
      -- sealed ballot came in is itself private while the match is on.
      coalesce((SELECT max((e.body->'body'->>'at')::timestamptz) FROM events e
        WHERE e.match_id = m.id AND e.body->'audience' = '"public"'::jsonb), m.created_at) AS updated_at,
      m.players,
      (o.match_id IS NOT NULL) AS live,
      r.result
    FROM matches m
    LEFT JOIN open_matches o ON o.match_id = m.id
    LEFT JOIN results r ON r.match_id = m.id
    -- A room's match, live or finished, is never listed.
    WHERE NOT EXISTS (SELECT 1 FROM lab_matches l WHERE l.match_id = m.id)
    ORDER BY (o.match_id IS NOT NULL) DESC, m.created_at DESC, m.id
    LIMIT ${limit}`;
}
