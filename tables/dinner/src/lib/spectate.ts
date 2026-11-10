import {
  type Feed,
  type FeedList,
  LIMITS,
  SPECTATOR_FORMAT,
  SPECTATOR_LIST_FORMAT,
  visibleText,
} from "@unprompted-tables/spectator";
import { briefFor, type Deal } from "./deal";
import {
  backers,
  due,
  guestOf,
  leader,
  type MatchEvent,
  type MatchState,
} from "./match";
import { bounds, type Report } from "./score";
import { GAME, TABLE_NAME } from "./settings";

// What people see of a party, in Unprompted's spectator format. Built only
// from public events while the party is on: players read this feed too, so
// no brief, feeling or deal reaches it until the end, when all are revealed.

const TABLE = { name: TABLE_NAME, game: GAME };
const id = (guest: string) => guest.toLowerCase();
const pct = (x: number) => `${Math.round(x * 100)}%`;
const list = (s: string[]) => s.join(", ");

function clock(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

const HOW: Record<string, string> = {
  consensus: "Everyone backed {p}, so that's the seating.",
  majority: "Most of the table backed {p}, so that's the seating.",
  most_backed: "Time ran out. {p} had the most backing, so it's the seating.",
  fairest:
    "Time ran out with no clear favourite, so the host seated everyone as fairly as the briefs allowed.",
  best_total:
    "Time ran out with no clear favourite, so the host seated everyone for the happiest table overall.",
  random:
    "Time ran out with no clear favourite, so the seats were drawn at random.",
};

export function feed(s: MatchState, events: MatchEvent[]): Feed {
  const guest = (player: string) => id(guestOf(s, player) ?? player);
  const timeline: Feed["timeline"] = [];
  const push = (e: Feed["timeline"][number]) => {
    if (e.text) timeline.push(e);
  };
  let updated = s.opened;
  for (const { audience, body: b } of events) {
    // Private events never reach the feed, whatever their kind.
    if (audience !== "public") continue;
    updated = b.at;
    if (b.kind === "guests") {
      const deadline = due({ ...s, phase: "talk" });
      const lock =
        s.variant.lock.consensus === "all"
          ? "once everyone backs the same plan"
          : "once most of the table backs one plan";
      push({
        at: b.at,
        kind: "phase",
        by: null,
        text: `Dinner is served. ${b.guests.length} guests, one round table. Seating locks ${lock}, or at ${clock(deadline?.toISOString() ?? b.at)}.`,
      });
    } else if (b.kind === "talk")
      push({
        at: b.at,
        kind: "talk",
        by: guest(b.player),
        text: visibleText(b.text),
      });
    else if (b.kind === "propose")
      push({
        at: b.at,
        kind: "action",
        by: guest(b.player),
        text: `Proposed ${b.proposal}: ${list(b.seating)}.`,
      });
    else if (b.kind === "back")
      push({
        at: b.at,
        kind: "action",
        by: guest(b.player),
        text: b.proposal ? `Backs ${b.proposal}.` : "Withdrew their backing.",
      });
    else if (b.kind === "end")
      push({
        at: b.at,
        kind: "notice",
        by: null,
        text: (HOW[b.how] ?? "Seating locked.").replace(
          "{p}",
          b.proposal ?? "",
        ),
      });
  }
  const participants: Feed["participants"] = s.players.map((p, i) => ({
    id: id(s.guests[i] as string),
    label: s.guests[i] as string,
    handle: p,
    kind: "bot",
    ...(s.personas[i]
      ? { note: visibleText(s.personas[i] as string, LIMITS.label) }
      : {}),
  }));
  const top = leader(s);
  const seats = s.end?.seating ?? top?.seating;
  const board = seats
    ? {
        kind: "seating",
        title: s.end
          ? "Final seating"
          : `Most backed so far: ${top?.id} (${backers(s, top?.id ?? "").length} of ${s.players.length})`,
        tables: [{ label: "Table", shape: "round", seats: seats.map(id) }],
      }
    : undefined;
  const deadline = due(s);
  return {
    format: SPECTATOR_FORMAT,
    table: TABLE,
    match: {
      id: s.id,
      status: s.end ? "over" : "live",
      started_at: s.opened,
      updated_at: updated,
      phase: s.end
        ? null
        : { label: "Table talk", due: deadline?.toISOString() ?? null },
      summary: s.end
        ? `Seated: ${list(s.end.seating)}.`
        : `${s.proposals.length} proposal${s.proposals.length === 1 ? "" : "s"} so far.`,
    },
    participants,
    timeline: timeline.slice(-LIMITS.timeline),
    ...(board ? { board } : {}),
    outcome: s.end ? outcome(s) : null,
  };
}

function outcome(s: MatchState): NonNullable<Feed["outcome"]> {
  const end = s.end as NonNullable<MatchState["end"]>;
  const r = end.report;
  const d = end.deal as Deal;
  const low = r.satisfaction.indexOf(r.worst_off);
  return {
    summary:
      `${(HOW[end.how] ?? "").replace("{p}", end.proposal ?? "")} ${d.guests[low]} came off worst, at ${pct(r.worst_off)} satisfaction.${r.worst_off >= r.best_worst_off - 1e-9 ? " No seating would have left its worst-off guest better off." : ""}`.trim(),
    measures: [
      {
        label: "Value captured",
        value: r.value_captured,
        format: "percent",
        note: "How the table's total compares with the best and worst any seating gives.",
      },
      {
        label: "Worst-off guest",
        value: r.worst_off,
        format: "percent",
        note: "The least satisfied guest, against their own best and worst.",
      },
      {
        label: "Best possible for the worst-off",
        value: r.best_worst_off,
        format: "percent",
        note: "What the fairest seating would have given its least satisfied guest.",
      },
      {
        label: "Swaps both would take",
        value: r.swaps.length,
        format: "number",
        note: "Pairs of guests who'd both be happier trading seats.",
      },
    ],
    scores: scoreTable(s.guests, d, r),
    reveals: s.guests.map((g, i) => {
      const b = briefFor(d, i);
      const numbers = Object.entries(b.feelings)
        .map(([who, n]) => `${who} ${n > 0 ? "+" : ""}${n}`)
        .join(", ");
      return {
        participant: id(g),
        title: `${g}'s brief`,
        text: visibleText(`${b.text}\n${numbers}`, LIMITS.reveal),
      };
    }),
  };
}

// Score, worst and best are all in the guest's own points, so a reader can
// see where satisfaction comes from: Otto's 2 between -4 and 6 is 60%, not
// 2 of 6. The fairest-seating column only shows when the seating differs
// from the fairest one for someone; otherwise every row would read 0% and
// the summary says it in words instead.
export function scoreTable(
  guests: readonly string[],
  d: Pick<Deal, "feel">,
  r: Pick<Report, "scores" | "satisfaction" | "short_of_fairest">,
): NonNullable<NonNullable<Feed["outcome"]>["scores"]> {
  const b = bounds(d.feel);
  const showFairest = !isFairest(r);
  return {
    columns: [
      { key: "score", label: "Score", format: "number" },
      { key: "worst", label: "Worst possible", format: "number" },
      { key: "best", label: "Best possible", format: "number" },
      { key: "satisfaction", label: "Satisfaction", format: "percent" },
      ...(showFairest
        ? [
            {
              key: "vs_fairest",
              label: "Against fairest seating",
              format: "percent" as const,
            },
          ]
        : []),
    ],
    rows: guests.map((g, i) => ({
      participant: id(g),
      values: {
        score: r.scores[i] ?? null,
        worst: b.worst[i] ?? null,
        best: b.best[i] ?? null,
        satisfaction: r.satisfaction[i] ?? null,
        // Positive: better off than the fairest seating would have left them.
        ...(showFairest
          ? {
              vs_fairest:
                r.short_of_fairest[i] === undefined
                  ? null
                  : 0 - r.short_of_fairest[i],
            }
          : {}),
      },
    })),
  };
}

// Every guest got exactly what the fairest seating gives them.
function isFairest(r: Pick<Report, "short_of_fairest">): boolean {
  return r.short_of_fairest.every((x) => Math.abs(x) < 1e-9);
}

export function feedList(
  rows: {
    id: string;
    started_at: Date;
    updated_at: Date;
    players: number;
    live: boolean;
    summary: string | null;
  }[],
): FeedList {
  return {
    format: SPECTATOR_LIST_FORMAT,
    table: TABLE,
    matches: rows.slice(0, LIMITS.listed).map((r) => ({
      id: r.id,
      status: r.live ? "live" : "over",
      started_at: r.started_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      players: r.players,
      ...(r.summary
        ? {
            summary: visibleText(r.summary, LIMITS.label * 2).replace(
              /\s+/g,
              " ",
            ),
          }
        : {}),
    })),
  };
}
