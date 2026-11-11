-- The open floor (rules_version 3) closes each motion's vote with its
-- ballots published together, and keeps each sealed guess at a secret, as
-- events of their own. Existing kinds are unchanged; older matches never
-- use these.
ALTER TABLE events DROP CONSTRAINT events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (
  kind IN ('start', 'guests', 'deal', 'brief', 'talk', 'propose', 'back', 'end', 'round', 'motion', 'name')
);
