-- After dinner in a room (src/lib/lab/exit.ts, docs/LAB.md at the repo's
-- root): each seat's one sealed answer to the exit question, given once
-- the place cards are printed and before its window closes. Append-only,
-- like the events: an answer is never changed or taken back. Read by the
-- seat that gave it and, once the window has closed, by the room's record.

-- The pair a composite key needs, on lab_matches as it stands.
CREATE UNIQUE INDEX lab_matches_room_match ON lab_matches (room, match_id);

-- Question 1's answers: four seats, each one of the three choices.
CREATE FUNCTION lab_beliefs_ok(b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(b) IS DISTINCT FROM 'object' THEN false ELSE
    (SELECT count(*) = 4
        AND bool_and(jsonb_typeof(b -> key) = 'string'
          AND value IN ('person', 'assistant', 'cant_tell'))
      FROM jsonb_each_text(b))
  END
$$;

CREATE TABLE lab_exits (
  room text NOT NULL,
  match_id text NOT NULL,
  player text NOT NULL REFERENCES players(handle),
  -- Question 1: each other seat's guest, and what this seat took it for.
  beliefs jsonb NOT NULL CHECK (lab_beliefs_ok(beliefs)),
  -- Questions 2 and 3, in the seat's words.
  why text NOT NULL CHECK (char_length(why) BETWEEN 1 AND 1000),
  said_in_person text NOT NULL
    CHECK (char_length(said_in_person) BETWEEN 1 AND 1000),
  at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room, player),
  -- Only a seat of the room's match answers: its player and its match.
  FOREIGN KEY (room, match_id) REFERENCES lab_matches(room, match_id)
);

CREATE TRIGGER lab_exits_append_only BEFORE UPDATE OR DELETE ON lab_exits
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
