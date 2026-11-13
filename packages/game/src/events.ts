// An opt-in envelope, not a shared event taxonomy. Recipients are a snapshot
// of seat IDs chosen by the Table when it appends the event. Never serialize
// private recipient lists to readers: those lists may themselves be secrets.
export type VisibleEvent<T, Seat = string> = {
  audience: "public" | readonly Seat[];
  body: T;
};

export function visibleEvents<T, Seat>(
  events: readonly VisibleEvent<T, Seat>[],
  seat: Seat | null,
): T[] {
  return events
    .filter(
      (e) =>
        e.audience === "public" || (seat !== null && e.audience.includes(seat)),
    )
    .map((e) => e.body);
}

// A delta read: the events one seat can see after the first `after` of
// them, and how many it can see in all, which is its next cursor. `after`
// counts only events visible to that seat, so it never steps over (or
// reveals the size of) a gap made by events sent to others. Visibility is
// fixed when an event is appended, so a seat's list only ever grows at
// its end. A count it can't have been given (null, or past the end) gets
// everything, marked as a resync.
export function visibleSince<T, Seat>(
  events: readonly VisibleEvent<T, Seat>[],
  seat: Seat | null,
  after: number | null,
): { events: T[]; seen: number; resync: boolean } {
  const all = visibleEvents(events, seat);
  const resync = after === null || after > all.length;
  return {
    events: resync ? all : all.slice(after),
    seen: all.length,
    resync,
  };
}
