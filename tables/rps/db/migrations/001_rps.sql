-- The rock paper scissors Table's own database. Unprompted's is separate;
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
-- player first joined. It never changes there, so it never changes here.
-- The ratings read it to leave brand-new accounts out.
CREATE TABLE players (
  handle text PRIMARY KEY CHECK (handle ~ '^[a-z][a-z0-9_-]{2,29}$'),
  on_site_since timestamptz NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now()
);

-- Players waiting for an opponent. A row goes when its player is paired,
-- leaves, or its time runs out.
CREATE TABLE queue (
  player text PRIMARY KEY CHECK (player ~ '^[a-z][a-z0-9_-]{2,29}$'),
  joined_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE matches (
  id text PRIMARY KEY CHECK (id ~ '^m_[A-Za-z0-9_-]{12}$'),
  players text[] NOT NULL CHECK (
    cardinality(players) = 2 AND players[1] <> players[2]
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matches_players ON matches USING gin (players);
CREATE INDEX matches_created ON matches (created_at DESC);

-- Everything that happened in a match, in order. A match's state is
-- replayed from these, so they never change.
CREATE TABLE events (
  match_id text NOT NULL REFERENCES matches(id),
  seq int NOT NULL CHECK (seq >= 0),
  kind text NOT NULL CHECK (kind IN ('start', 'commit', 'reveal', 'timeout', 'round', 'end')),
  -- Replay trusts the body, so its kind and time are checked here too.
  body jsonb NOT NULL CHECK (body->>'kind' = kind AND body ? 'at' AND jsonb_typeof(body->'at') = 'string'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq)
);
-- Open matches: those without an end event.
CREATE UNIQUE INDEX events_end ON events (match_id) WHERE kind = 'end';

-- The matches still being played and when their current phase runs out.
-- Derived from the events, not history: a row changes with each phase and
-- goes when the match ends. It lets the Table find a player's match, and
-- the matches whose time ran out, without reading every match.
CREATE TABLE open_matches (
  match_id text PRIMARY KEY REFERENCES matches(id),
  players text[] NOT NULL,
  due timestamptz NOT NULL
);
CREATE INDEX open_matches_due ON open_matches (due);
CREATE INDEX open_matches_players ON open_matches USING gin (players);

-- One row per finished match that has a result, in the library's format.
CREATE TABLE results (
  match_id text PRIMARY KEY REFERENCES matches(id),
  result jsonb NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX results_at ON results (at);

CREATE TRIGGER matches_append_only BEFORE UPDATE OR DELETE ON matches
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER players_append_only BEFORE UPDATE OR DELETE ON players
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER results_append_only BEFORE UPDATE OR DELETE ON results
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
