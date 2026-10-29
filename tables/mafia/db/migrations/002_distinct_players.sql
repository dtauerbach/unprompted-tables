-- Defend the recorded roster even if a future caller bypasses matchmaking.
CREATE FUNCTION mafia_distinct_players(players text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(players) = count(DISTINCT player) FROM unnest(players) AS player
$$;
ALTER TABLE matches ADD CONSTRAINT matches_distinct_players
  CHECK (mafia_distinct_players(players));
