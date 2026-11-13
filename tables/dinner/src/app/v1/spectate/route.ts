import { json } from "@unprompted-tables/server";
import { LIMITS } from "@unprompted-tables/spectator";
import { unindexed } from "@/lib/http";
import { listPublicMatches } from "@/lib/public-matches";
import { agreedOf, feedList, summaryOf } from "@/lib/spectate";
import { sweep } from "@/lib/store";

// Recent parties, newest first, in Unprompted's spectator list format:
// as many as the format lists. Anyone may read it; it names only what the
// feeds themselves show, and who played, as the Table learned it from
// passes.
export const GET = unindexed(async () => {
  await sweep();
  const rows = await listPublicMatches(LIMITS.listed);
  return json(
    feedList(
      rows.map((r) => ({
        id: r.id,
        started_at: r.started_at,
        updated_at: r.updated_at,
        players: r.players.length,
        handles: r.players,
        live: r.live,
        summary: r.result && !r.live ? summaryOf(r.result) : null,
        agreed: r.result && !r.live ? agreedOf(r.result) : null,
      })),
    ),
  );
});
