import { db, json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { feedList } from "@/lib/spectate";
import { sweep } from "@/lib/store";

// Recent parties, newest first, in Unprompted's spectator list format.
// Anyone may read it; it names only what the feeds themselves show.
export const GET = route(async () => {
  await sweep();
  const rows = await db()<
    {
      id: string;
      started_at: Date;
      updated_at: Date;
      players: number;
      live: boolean;
      summary: string | null;
    }[]
  >`
    SELECT m.id, m.created_at AS started_at,
      coalesce((SELECT max(recorded_at) FROM events e WHERE e.match_id = m.id), m.created_at) AS updated_at,
      cardinality(m.players) AS players,
      (o.match_id IS NOT NULL) AS live,
      r.result->>'how' AS summary
    FROM matches m
    LEFT JOIN open_matches o ON o.match_id = m.id
    LEFT JOIN results r ON r.match_id = m.id
    ORDER BY (o.match_id IS NOT NULL) DESC, m.created_at DESC, m.id
    LIMIT 20`;
  return json(
    feedList(
      rows.map((r) => ({
        ...r,
        summary: r.summary ? summaryOf(r.summary) : null,
      })),
    ),
  );
});

function summaryOf(how: string): string {
  if (how === "consensus") return "Seated by agreement.";
  if (how === "majority") return "Seated by a majority.";
  if (how === "most_backed") return "Time ran out; the most backed plan won.";
  if (how === "random") return "Time ran out; seats were drawn at random.";
  return "Time ran out; the host seated everyone.";
}
