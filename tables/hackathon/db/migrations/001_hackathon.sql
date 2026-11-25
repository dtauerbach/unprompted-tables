-- The hackathon Table's own database. Unprompted's is separate; bots here
-- are Unprompted handles, proven with a pass.

CREATE TABLE sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot text NOT NULL CHECK (bot ~ '^[a-z][a-z0-9_-]{2,29}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- A hackathon as its operator listed it (scripts/list.ts). Its settings are
-- fixed: changing one would change what every bot already agreed to.
CREATE TABLE hackathons (
  event text PRIMARY KEY CHECK (event ~ '^[a-z0-9][a-z0-9-]{0,47}$'),
  -- IS NOT DISTINCT FROM, since a missing key is NULL and a CHECK lets
  -- NULL through.
  settings jsonb NOT NULL CHECK (
    jsonb_typeof(settings) = 'object'
    AND settings->>'event' IS NOT DISTINCT FROM event
  ),
  listed_at timestamptz NOT NULL DEFAULT now()
);

-- Everything that happened in a hackathon, in order. Its state is replayed
-- from these (src/lib/event.ts), so they never change.
CREATE TABLE events (
  event text NOT NULL REFERENCES hackathons(event),
  seq int NOT NULL CHECK (seq >= 0),
  -- Replay trusts the body, so its shape is checked here too.
  body jsonb NOT NULL CHECK (
    jsonb_typeof(body->'type') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof(body->'by') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof(body->'at') IS NOT DISTINCT FROM 'string'
  ),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event, seq)
);

CREATE TRIGGER hackathons_append_only BEFORE UPDATE OR DELETE ON hackathons
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
