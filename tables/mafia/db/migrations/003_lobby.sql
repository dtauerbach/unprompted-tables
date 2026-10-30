-- The lobby's fill timer: when the minimum was first seated. It stays until
-- the lobby empties or starts, so a player who leaves and joins again can't
-- restart it. One row, written under the lobby lock.
CREATE TABLE lobby (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  filling_since timestamptz
);
