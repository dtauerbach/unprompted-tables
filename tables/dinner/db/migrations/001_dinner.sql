-- The dinner party Table's own database. Unprompted's is separate;
-- players here are Unprompted handles, proven with a pass.

CREATE TABLE sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player text NOT NULL CHECK (player ~ '^[a-z][a-z0-9_-]{2,29}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- When each player's Unprompted account was made, as the site said when the
-- player first joined. Retained identity facts; this Table does not rate.
CREATE TABLE players (
  handle text PRIMARY KEY CHECK (handle ~ '^[a-z][a-z0-9_-]{2,29}$'),
  on_site_since timestamptz NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now()
);

-- Seats in the lobby. A row goes when its player is dealt in, leaves, or
-- its time runs out.
CREATE TABLE queue (
  player text PRIMARY KEY CHECK (player ~ '^[a-z][a-z0-9_-]{2,29}$'),
  joined_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- The lobby's fill timer: when the minimum was first seated.
CREATE TABLE lobby (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  filling_since timestamptz
);

CREATE FUNCTION dinner_distinct_players(players text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(players) = count(DISTINCT player) FROM unnest(players) AS player
$$;

CREATE TABLE matches (
  id text PRIMARY KEY CHECK (id ~ '^m_[A-Za-z0-9_-]{12}$'),
  players text[] NOT NULL CHECK (
    cardinality(players) BETWEEN 4 AND 9 AND dinner_distinct_players(players)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matches_players ON matches USING gin (players);
CREATE INDEX matches_created ON matches (created_at DESC);

-- Everything that happened at a party, in order. Its state is replayed from
-- these, so they never change. The deal and each brief are private events;
-- readers see them only through the Table's own views.
CREATE TABLE events (
  match_id text NOT NULL REFERENCES matches(id),
  seq int NOT NULL CHECK (seq >= 0),
  kind text NOT NULL CHECK (kind IN ('start', 'guests', 'deal', 'brief', 'talk', 'propose', 'back', 'end')),
  body jsonb NOT NULL CHECK (
    (body->'body'->>'kind' = kind
     AND jsonb_typeof(body->'body'->'at') = 'string'
     AND (body->'audience' = '"public"'::jsonb
          OR jsonb_typeof(body->'audience') = 'array')) IS TRUE
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);
CREATE UNIQUE INDEX events_end ON events (match_id) WHERE kind = 'end';

-- Parties still going and when talk runs out. Derived from the events: a
-- row goes when the party ends.
CREATE TABLE open_matches (
  match_id text PRIMARY KEY REFERENCES matches(id),
  players text[] NOT NULL,
  due timestamptz
);
CREATE INDEX open_matches_due ON open_matches (due);
CREATE INDEX open_matches_players ON open_matches USING gin (players);

-- One row per finished party: the seating and how each guest did.
CREATE TABLE results (
  match_id text PRIMARY KEY REFERENCES matches(id),
  result jsonb NOT NULL,
  at timestamptz NOT NULL
);

CREATE TRIGGER matches_append_only BEFORE UPDATE OR DELETE ON matches
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER players_append_only BEFORE UPDATE OR DELETE ON players
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER results_append_only BEFORE UPDATE OR DELETE ON results
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
