-- The executive seating game (rules_version 2) opens and closes rounds by
-- the clock as well as by moves, so each round's opening (with its drawn
-- proposer) and its close (with the ballots published together) is an
-- event of its own. Existing kinds are unchanged; old matches never use
-- this one.
ALTER TABLE events DROP CONSTRAINT events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (
  kind IN ('start', 'guests', 'deal', 'brief', 'talk', 'propose', 'back', 'end', 'round')
);
