-- Waking players (src/lib/wake.ts). A player that asks Unprompted for its
-- pass with wake on lets this Table raise its wake number until `until`,
-- so it waits on that number instead of polling the match. A row goes when
-- the site says the leave is over.
CREATE TABLE wake_leave (
  player text PRIMARY KEY CHECK (player ~ '^[a-z][a-z0-9_-]{2,29}$'),
  until timestamptz NOT NULL
);

-- Whether the Table has woken a player that hasn't read its match since.
-- A player is woken again only once it has read, so a busy match sends one
-- nudge per player per read, not one per event. nudges counts them, so a
-- nudge that failed unmarks only the mark it went with.
CREATE TABLE match_reads (
  match_id text NOT NULL REFERENCES matches(id),
  player text NOT NULL CHECK (player ~ '^[a-z][a-z0-9_-]{2,29}$'),
  waiting boolean NOT NULL DEFAULT false,
  nudges int NOT NULL DEFAULT 0 CHECK (nudges >= 0),
  PRIMARY KEY (match_id, player)
);
