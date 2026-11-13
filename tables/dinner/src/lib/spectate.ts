import {
  type Feed,
  type FeedList,
  LIMITS,
  SPECTATOR_FORMAT,
  SPECTATOR_LIST_FORMAT,
  visibleText,
} from "@unprompted-tables/spectator";
import { briefFor, type Deal } from "./deal";
import { execFeed } from "./exec/feed";
import type { ExecEvent } from "./exec/game";
import { floorFeed } from "./floor/feed";
import type { FloorEvent } from "./floor/game";
import {
  backers,
  due,
  guestOf,
  leader,
  type MatchEvent,
  type MatchState,
} from "./match";
import { type AnyEvent, type AnyState, isExec, isFloor } from "./rules";
import { bounds, scores } from "./score";
import { GAME, TABLE_NAME } from "./settings";

// What people see of a match, in Unprompted's spectator format. The open
// floor's feed is in floor/feed.ts, the three-round game's in exec/feed.ts; the first party's, kept
// for matches already played, is below. Built only from public events while
// a party is on: players read this feed too, so no brief, feeling or deal
// reaches it until the end, when all are revealed.

const TABLE = { name: TABLE_NAME, game: GAME };

export function feed(s: AnyState, events: AnyEvent[]): Feed {
  if (isFloor(s)) return floorFeed(s, events as FloorEvent[], TABLE);
  return isExec(s)
    ? execFeed(s, events as ExecEvent[], TABLE)
    : partyFeed(s, events as MatchEvent[]);
}
const id = (guest: string) => guest.toLowerCase();
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

// The first party's ends in which the table itself settled the seating.
const AGREED = new Set(["consensus", "majority"]);

function partyFeed(s: MatchState, events: MatchEvent[]): Feed {
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
      ...(s.end ? { agreed: AGREED.has(s.end.how) } : {}),
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

// An ended party's bounds never change, and searching every seating on each
// read of a public feed adds up, so they're kept per deal (by its feelings,
// which are all they depend on), a few hundred deals at most.
const BOUNDS = new Map<
  string,
  { b: ReturnType<typeof bounds>; fair: number[] }
>();
export function boundsOf(d: Deal) {
  const key = JSON.stringify(d.feel);
  let hit = BOUNDS.get(key);
  if (!hit) {
    const b = bounds(d.feel);
    hit = { b, fair: scores(d.feel, b.fairest) };
    if (BOUNDS.size >= 256) BOUNDS.delete(BOUNDS.keys().next().value as string);
    BOUNDS.set(key, hit);
  }
  return hit;
}

// Every figure is a level a reader can check against the briefs: scores,
// and what the best, the worst and the fairest seating would have given.
// No percentages measured from the worst seating, which read 2 of a best 6
// as "60%", and no columns of differences.
function outcome(s: MatchState): NonNullable<Feed["outcome"]> {
  const end = s.end as NonNullable<MatchState["end"]>;
  const r = end.report;
  const d = end.deal as Deal;
  const { b, fair } = boundsOf(d);
  const total = r.scores.reduce((a, v) => a + v, 0);
  const lowest = Math.min(...r.scores);
  const low = r.scores.indexOf(lowest);
  return {
    summary:
      `${(HOW[end.how] ?? "").replace("{p}", end.proposal ?? "")} ${d.guests[low]} had the lowest score, ${lowest}, of a possible ${b.best[low]}.`.trim(),
    measures: [
      {
        label: "Total score",
        value: total,
        format: "number",
        note: `Every guest's score added up. The highest any seating gives is ${b.best_total}.`,
      },
      {
        label: "Lowest score",
        value: lowest,
        format: "number",
        note: `The seating fairest by the briefs left its lowest guest with ${Math.min(...fair)}.`,
      },
      {
        label: "Swaps both would take",
        value: r.swaps.length,
        format: "number",
        note: "Pairs of guests who'd both be happier trading seats.",
      },
    ],
    scores: {
      columns: [
        { key: "score", label: "Score", format: "number" },
        { key: "best", label: "Best possible", format: "number" },
        { key: "worst", label: "Worst possible", format: "number" },
        { key: "fairest", label: "Fairest seating gave", format: "number" },
      ],
      rows: s.guests.map((g, i) => ({
        participant: id(g),
        values: {
          score: r.scores[i] ?? null,
          best: b.best[i] ?? null,
          worst: b.worst[i] ?? null,
          fairest: fair[i] ?? null,
        },
      })),
    },
    reveals: s.guests.map((g, i) => {
      const brief = briefFor(d, i);
      const numbers = Object.entries(brief.feelings)
        .map(([who, n]) => `${who} ${n > 0 ? "+" : ""}${n}`)
        .join(", ");
      return {
        participant: id(g),
        title: `${g}'s brief`,
        text: visibleText(`${brief.text}\n${numbers}`, LIMITS.reveal),
      };
    }),
  };
}

// A handle as the format takes it. Players' handles come from passes, so
// all fit; one that somehow didn't would cost the whole list, so it's left
// out instead.
const HANDLE = /^[a-z][a-z0-9_-]{2,29}$/;

export function feedList(
  rows: {
    id: string;
    started_at: Date;
    updated_at: Date;
    players: number;
    handles?: string[];
    live: boolean;
    summary: string | null;
    agreed?: boolean | null;
  }[],
): FeedList {
  return {
    format: SPECTATOR_LIST_FORMAT,
    table: TABLE,
    matches: rows.slice(0, LIMITS.listed).map((r) => {
      const handles = [...new Set(r.handles ?? [])]
        .filter((h) => HANDLE.test(h))
        .slice(0, LIMITS.participants);
      return {
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
        ...(handles.length ? { handles } : {}),
        // Only once it's over, as the format says.
        ...(!r.live && typeof r.agreed === "boolean"
          ? { agreed: r.agreed }
          : {}),
      };
    }),
  };
}

type Result = {
  how?: string;
  round?: number;
  motion?: number | null;
  rules_version?: number;
};

// Whether a finished match's table settled on a seating: a standing motion
// at dinner on the open floor, a deal in the three-round game, and an
// agreement or a majority at the first party (not the host's choice when
// time ran out).
export function agreedOf(result: Result): boolean {
  const how = result.how ?? "";
  if (result.rules_version === 3) return how === "seated";
  if (result.rules_version === 2) return how === "deal";
  return AGREED.has(how);
}

// A finished match's one line on the list, in plain words.
export function summaryOf(result: Result): string {
  const how = result.how ?? "";
  if (result.rules_version === 3)
    return how === "seated"
      ? "Agreed on a seating."
      : "Dinner came with no seating agreed.";
  if (result.rules_version === 2)
    return how === "deal"
      ? `Agreed in round ${result.round}.`
      : "No deal: no seating passed.";
  if (how === "consensus") return "Seated by agreement.";
  if (how === "majority") return "Seated by a majority.";
  if (how === "most_backed") return "Time ran out; the most backed plan won.";
  if (how === "random") return "Time ran out; seats were drawn at random.";
  return "Time ran out; the host seated everyone.";
}
