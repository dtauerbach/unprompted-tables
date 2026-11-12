import { visibleEvents } from "@unprompted-tables/game";
import { ApiError } from "@unprompted-tables/server";
import page from "../../../content/lab/page.json";
import {
  act,
  EXECUTIVES,
  executiveOf,
  type FloorAction,
  type FloorEvent,
  type FloorState,
  floorOpensAt,
  type Motion,
  SPEAKER,
  servedWindow,
} from "../floor/game";
import { type Arm, whoFor } from "./texts";
import { cardsFor, fill, noteFor, type RoomDeal, reasonsFor } from "./words";

// What a seat in a room reads and does: the page, its tick, and the three
// moves. The engine underneath is today's open floor, untouched; this is a
// projection of it in words, by an explicit allowlist. A seat sees every
// other seat the same way, by its guest's name: no handle, no number of
// its own or anyone's points, and nothing that marks one seat apart.

export const NOTICE = page.notice;
export const REFUSALS = page.refusals;
export type RefusalKey = keyof typeof REFUSALS;

const name = (i: number) => EXECUTIVES[i] as string;
const own = <T>(r: Record<string, T>, k: string): T | undefined =>
  Object.hasOwn(r, k) ? r[k] : undefined;

// A room's deal in the form the note is built from: the engine's own deal
// (so the note and the match can never disagree) with the guests' reasons.
export function roomDealOf(s: FloorState): RoomDeal {
  const d = s.deal;
  if (!d) throw new Error("a room's match has its deal");
  return {
    weights: d.weights,
    secrets: d.secrets,
    reasons: reasonsFor(d.seed),
  };
}

// Each guest's two neighbours in a seating, Sage included, so nobody loses
// a seat to a counting slip.
export function besideOf(seating: readonly string[]): Record<string, string[]> {
  const ring = [SPEAKER, ...seating];
  return Object.fromEntries(
    seating.map((g, i) => [
      g,
      [ring[i] as string, ring[(i + 2) % ring.length] as string],
    ]),
  );
}

const answerOf = (b: "yes" | "no" | null | undefined) => b ?? null;

function statusOf(m: Motion): "open" | "passed" | "failed" | "void" {
  if (!m.close) return "open";
  if (m.close.by === "void") return "void";
  return m.close.passed ? "passed" : "failed";
}

// The page (GET /seating) for the seat `player` holds.
export function roomPage(
  room: { arm: Arm },
  s: FloorState,
  events: FloorEvent[],
  player: string,
  now: Date,
) {
  const me = executiveOf(s, player);
  if (me === null) throw new Error("only a seat reads its page");
  const over = s.phase === "over";
  // A room shows a seat what it saw in play, even once the cards are
  // printed: the record (later) is where everything comes out.
  const seen = visibleEvents(events, player);
  const mine = s.motions.filter((m) => m.mover === me);
  const opens = floorOpensAt(s);
  const { from, to } = servedWindow(s);
  return {
    who: whoFor(room.arm),
    you: {
      seat: name(me),
      note: noteFor(roomDealOf(s), me),
      proposals_left: s.rules.motions_per_assistant - mine.length,
      open_proposal: mine.find((m) => !m.close)?.id ?? null,
      messages_left:
        s.rules.messages_per_assistant - (own(s.talks, player) ?? 0),
    },
    asked_host: cardsFor(s.deal as NonNullable<FloorState["deal"]>),
    clock: {
      now: now.toISOString(),
      started_at: s.opened,
      proposals_from: opens.toISOString(),
      proposals_open: !over && now >= opens,
      cards_between: [from.toISOString(), to.toISOString()],
      cards_printed_at: over ? (s.end?.at ?? null) : null,
    },
    plan: s.standing
      ? {
          proposal: s.standing.motion,
          seating: s.standing.seating.map(name),
          beside: besideOf(s.standing.seating.map(name)),
          since: s.standing.since,
        }
      : null,
    proposals: s.motions.map((m) => {
      const seating = m.seating.map(name);
      const status = statusOf(m);
      return {
        proposal: m.id,
        by: name(m.mover),
        seating,
        beside: besideOf(seating),
        at: m.at,
        closes_at: m.closes_at,
        status,
        ...(m.mover !== me && !m.close
          ? { your_answer: answerOf(own(m.ballots, player)) }
          : {}),
        ...(m.close && m.close.by !== "void"
          ? {
              closed_at: m.close.at,
              answers: Object.fromEntries(
                EXECUTIVES.flatMap((x, i) =>
                  i === m.mover ? [] : [[x, answerOf(m.close?.ballots[i])]],
                ),
              ),
              yes: m.close.yes,
              no: m.close.no,
            }
          : {}),
      };
    }),
    talk: seen.flatMap((e) =>
      e.kind === "talk"
        ? [
            {
              at: e.at,
              seat: name(executiveOf(s, e.player) as number),
              to: e.to?.[0] ?? null,
              untrusted_text: e.text,
            },
          ]
        : [],
    ),
    notice: NOTICE,
  };
}
export type RoomPage = ReturnType<typeof roomPage>;

// A number that rises when the seat's page changes: the events it can see,
// and the moment proposals open. Nothing another seat does alone (a
// private word between two others, a sealed answer) moves it.
export function tickOf(
  s: FloorState,
  events: FloorEvent[],
  player: string,
  now: Date,
): number {
  return (
    visibleEvents(events, player).length + (now >= floorOpensAt(s) ? 1 : 0)
  );
}

// ---------------------------------------------------------------- moves

export type RoomAction =
  | { kind: "say"; text: string; to?: string }
  | { kind: "propose"; seating: string[] }
  | { kind: "answer"; proposal: number; yes: boolean };

// The engine's move for each room move. A room has no naming, no
// ?seating= and no points: there is nothing to map them from.
export function engineAction(a: RoomAction): FloorAction {
  if (a.kind === "say")
    return {
      kind: "talk",
      text: a.text,
      ...(a.to === undefined ? {} : { to: [a.to] }),
    };
  if (a.kind === "propose") return { kind: "motion", seating: a.seating };
  return { kind: "vote", motion: a.proposal, ballot: a.yes ? "yes" : "no" };
}

// The engine's refusals, each with the room's own words. The status is the
// engine's. One the room never expects comes out as "refused".
export const REFUSAL_OF: Record<string, RefusalKey> = {
  invalid_text: "invalid_text",
  too_long: "too_long",
  talk_limit: "message_limit",
  unknown_recipient: "unknown_seat",
  no_self_message: "own_seat",
  match_over: "cards_printed",
  invalid_seating: "invalid_seating",
  floor_not_open: "not_open_yet",
  motion_limit: "proposal_limit",
  motion_open: "proposal_open",
  already_standing: "already_the_plan",
  already_moved: "already_open",
  no_such_motion: "no_such_proposal",
  mover_counts_as_yes: "yours_counts_as_yes",
  voting_closed: "answers_closed",
  already_voted: "already_answered",
};

export function refusal(
  status: number,
  key: RefusalKey,
  values: Record<string, string> = {},
): ApiError {
  const text = REFUSALS[key];
  // Only the slots this text has.
  const used = Object.fromEntries(
    Object.entries(values).filter(([k]) => text.includes(`{${k}}`)),
  );
  return new ApiError(status, key, fill(text, used));
}

function roomRefusal(
  err: ApiError,
  s: FloorState,
  a: RoomAction,
  player: string,
): ApiError {
  const me = executiveOf(s, player);
  const open = s.motions.find((m) => m.mover === me && !m.close);
  const proposal =
    a.kind === "answer"
      ? String(a.proposal)
      : err.code === "motion_open"
        ? String(open?.id ?? "")
        : err.code === "already_moved"
          ? (err.message.match(/motion (\d+)/)?.[1] ?? "")
          : "";
  if (err.code === "invalid_text" && a.kind === "say" && !a.text.trim())
    return refusal(400, "empty_text");
  const key = REFUSAL_OF[err.code] ?? "refused";
  return refusal(err.status, key, {
    proposal,
    char: err.message.match(/U\+[0-9A-F]{4,6}/)?.[0] ?? "",
    chars: String(s.rules.message_chars),
    messages: String(s.rules.messages_per_assistant),
    proposals: String(s.rules.motions_per_assistant),
    at: floorOpensAt(s).toISOString(),
  });
}

// A seat's move: the engine's act, its refusals in the room's words.
export function roomAct(
  s: FloorState,
  player: string,
  a: RoomAction,
  now: Date,
): FloorEvent[] {
  try {
    return act(s, player, engineAction(a), now);
  } catch (err) {
    if (err instanceof ApiError) throw roomRefusal(err, s, a, player);
    throw err;
  }
}
