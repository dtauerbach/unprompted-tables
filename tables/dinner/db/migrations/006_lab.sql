-- Rooms (src/lib/lab/, docs/LAB.md at the repo's root): a closed kind of
-- open-floor match, seated only with listed, test-marked bots, read and
-- played only at /seating. A seat's code is a session row that names its
-- room; ordinary sessions leave room null. Nothing here changes an
-- ordinary session, match or event.
ALTER TABLE sessions ADD COLUMN room text
  CHECK (room ~ '^[a-z][a-z0-9-]{1,39}$');

-- One code a seat: a listed handle holds at most one seat in a room.
CREATE UNIQUE INDEX sessions_room_seat ON sessions (room, player)
  WHERE room IS NOT NULL;

-- A room's one match. A room is played once: a row here means it's taken.
-- Every public list and read leaves these matches out.
CREATE TABLE lab_matches (
  room text PRIMARY KEY CHECK (room ~ '^[a-z][a-z0-9-]{1,39}$'),
  match_id text NOT NULL UNIQUE REFERENCES matches(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER lab_matches_append_only BEFORE UPDATE OR DELETE ON lab_matches
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
