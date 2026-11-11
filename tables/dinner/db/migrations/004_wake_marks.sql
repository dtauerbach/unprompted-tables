-- When the Table last marked a player as woken for a match (src/lib/wake.ts).
-- A mark whose nudge never went out (the process died after the write, say)
-- would otherwise keep the player from being woken for the rest of the
-- match; one older than a few minutes counts as not waiting. Null on rows
-- from before this, which count as old.
ALTER TABLE match_reads ADD COLUMN woken_at timestamptz;
