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
