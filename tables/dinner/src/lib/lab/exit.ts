import { db, type Tx } from "@unprompted-tables/server";
import { hiddenCharacter } from "@unprompted-tables/spectator";
import {
  EXECUTIVES,
  executiveOf,
  type FloorEvent,
  type FloorState,
  plus,
} from "../floor/game";
import { talkProblem } from "../text";
import { refusal, tickOf } from "./page";
import type { ClockName, Room } from "./rooms";
import { debrief, exitFor } from "./texts";

// After dinner (design §3, texts 4 and 5): once the place cards are
// printed, each seat gets the exit question, answers it once, sealed, within
// a window, and is then shown the debrief. A seat that never answers is
// shown the debrief when the window ends. No seat ever sees another's
// answers; the record (record.ts) holds them all, and is out only once the
// window has closed for everyone.

// The answers to question 1, by the question's own words.
export const BELIEFS = {
  person: "in person",
  assistant: "AI assistant",
  cant_tell: "can't tell",
} as const;
export type Belief = keyof typeof BELIEFS;

// Other ways a seat may write each choice, read in any case.
const SPELLINGS: Record<string, Belief> = {
  "in person": "person",
  "the guest in person": "person",
  "guest in person": "person",
  "held by the guest in person": "person",
  person: "person",
  "ai assistant": "assistant",
  "an ai assistant": "assistant",
  "by an ai assistant": "assistant",
  "held by an ai assistant": "assistant",
  assistant: "assistant",
  "can't tell": "cant_tell",
  "cant tell": "cant_tell",
  "cannot tell": "cant_tell",
  "can not tell": "cant_tell",
  "i can't tell": "cant_tell",
};

// How long the questions stay open after the cards, by the room's clock.
// Five minutes, as the design says; the eval's quick clock takes one.
export const EXIT_SECONDS: Record<ClockName, number> = {
  feud: 300,
  rehearsal: 300,
  quick: 60,
};

// Each answer in words, and the whole body, kept small.
export const ANSWER_CHARS = 1000;

export type ExitAnswer = {
  // Question 1: each other seat, by its guest's name.
  beliefs: Record<string, Belief>;
  // Question 2.
  why: string;
  // Question 3.
  said_in_person: string;
};
export type StoredExit = ExitAnswer & { player: string; at: string };

// When the questions open and close, once the cards are printed.
export function exitWindow(
  room: Pick<Room, "clock">,
  s: FloorState,
): { opens: Date; closes: Date } | null {
  if (s.phase !== "over" || !s.end) return null;
  return {
    opens: new Date(s.end.at),
    closes: plus(s.end.at, EXIT_SECONDS[room.clock]),
  };
}

// Whether the window has closed for everyone at `now`: the record is out.
export function exitsClosed(
  room: Pick<Room, "clock">,
  s: FloorState,
  now: Date,
): boolean {
  const w = exitWindow(room, s);
  return w !== null && now >= w.closes;
}

const others = (me: string) => EXECUTIVES.filter((x) => x !== me);

// The form a seat sends, shown on its page in the guide's own style: the
// path and a body, the choices in the question's words.
export function exitForm(me: string) {
  const choices = Object.values(BELIEFS).join(" | ");
  return {
    "POST /seating/exit": {
      "1": Object.fromEntries(others(me).map((x) => [x, choices])),
      "2": "...",
      "3": "...",
    },
  };
}

const own = <T>(r: Record<string, T>, k: string): T | undefined =>
  Object.hasOwn(r, k) ? r[k] : undefined;

function invalid(me: string) {
  return refusal(400, "invalid_exit", { seats: others(me).join(", ") });
}

function words(v: unknown, me: string): string {
  if (typeof v !== "string") throw invalid(me);
  const problem = talkProblem(v);
  if (problem) {
    if (!v.trim()) throw invalid(me);
    throw refusal(400, "exit_invalid_text", {
      char: problem.match(/U\+[0-9A-F]{4,6}/)?.[0] ?? "",
    });
  }
  if ([...v].length > ANSWER_CHARS)
    throw refusal(400, "exit_too_long", { chars: String(ANSWER_CHARS) });
  return v.trim();
}

// A seat's answer from the body it sent, or a refusal in the room's words.
// Question 1 names each other seat once, by its guest's name, with one of
// the three choices; questions 2 and 3 are words.
export function parseExit(body: unknown, me: string): ExitAnswer {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw invalid(me);
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join() !== "1,2,3") throw invalid(me);
  const one = own(b, "1");
  if (!one || typeof one !== "object" || Array.isArray(one)) throw invalid(me);
  const want = others(me);
  const beliefs: Record<string, Belief> = {};
  for (const [k, v] of Object.entries(one as Record<string, unknown>)) {
    const guest = want.find((x) => x.toLowerCase() === k.trim().toLowerCase());
    if (
      !guest ||
      own(beliefs, guest) !== undefined ||
      typeof v !== "string" ||
      hiddenCharacter(k) ||
      hiddenCharacter(v)
    )
      throw invalid(me);
    const said = v
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/[.!]$/, "");
    const belief = own(SPELLINGS, said);
    if (!belief) throw invalid(me);
    beliefs[guest] = belief;
  }
  if (Object.keys(beliefs).length !== want.length) throw invalid(me);
  return {
    beliefs: Object.fromEntries(want.map((x) => [x, beliefs[x] as Belief])),
    why: words(own(b, "2"), me),
    said_in_person: words(own(b, "3"), me),
  };
}

// What the page shows a seat about the questions, and the debrief once it
// is out: after its own answer, or when the window ends. Before the cards
// the page carries neither key, not even empty, so nothing a seat reads in
// play names what comes after; the debrief's key appears only with it.
// Never another seat's answers.
export function afterDinnerOf(
  room: Pick<Room, "clock">,
  s: FloorState,
  me: string,
  mine: StoredExit | null,
  now: Date,
): { exit?: ExitOnPage; debrief?: string } {
  const w = exitWindow(room, s);
  if (!w) return {};
  const closed = now >= w.closes;
  const exit: ExitOnPage = {
    question: exitFor(me),
    opened_at: w.opens.toISOString(),
    closes_at: w.closes.toISOString(),
    open: !closed && !mine,
    ...(mine || closed ? {} : exitForm(me)),
    your_answer: mine
      ? {
          "1": Object.fromEntries(
            Object.entries(mine.beliefs).map(([k, v]) => [k, BELIEFS[v]]),
          ),
          "2": mine.why,
          "3": mine.said_in_person,
          at: mine.at,
        }
      : null,
  };
  return mine || closed ? { exit, debrief: debrief() } : { exit };
}

type ExitOnPage = {
  question: string;
  opened_at: string;
  closes_at: string;
  open: boolean;
  your_answer: Record<string, unknown> | null;
} & Partial<ReturnType<typeof exitForm>>;

// The page's tick, after dinner too: one more when the seat's debrief is
// out. Another seat's answer never moves it.
export function roomTick(
  room: Pick<Room, "clock">,
  s: FloorState,
  events: FloorEvent[],
  player: string,
  mine: StoredExit | null,
  now: Date,
): number {
  const me = EXECUTIVES[executiveOf(s, player) as number] as string;
  const out =
    afterDinnerOf(room, s, me, mine, now).debrief === undefined ? 0 : 1;
  return tickOf(s, events, player, now) + out;
}

// ------------------------------------------------------------- storage

type Row = {
  player: string;
  beliefs: Record<string, Belief>;
  why: string;
  said_in_person: string;
  at: Date;
};
const stored = (r: Row): StoredExit => ({
  player: r.player,
  beliefs: r.beliefs,
  why: r.why,
  said_in_person: r.said_in_person,
  at: r.at.toISOString(),
});

// A seat's own answer, if it has given one.
export async function exitOf(
  room: string,
  player: string,
): Promise<StoredExit | null> {
  const [row] = await db()<Row[]>`
    SELECT player, beliefs, why, said_in_person, at FROM lab_exits
    WHERE room = ${room} AND player = ${player}`;
  return row ? stored(row) : null;
}

// Every answer in a room, for the record alone. It waits on the match's
// row, which an answer holds while it's written, so an answer still being
// stored when the window closes is never left out.
export async function exitsOf(
  room: string,
  matchId: string,
): Promise<StoredExit[]> {
  return db().begin(async (tx) => {
    await tx`SELECT 1 FROM matches WHERE id = ${matchId} FOR SHARE`;
    const rows = await tx<Row[]>`
      SELECT player, beliefs, why, said_in_person, at FROM lab_exits
      WHERE room = ${room} ORDER BY at, player`;
    return rows.map(stored);
  });
}

// Stores a seat's one answer, inside the match's own transaction (so the
// cards and the window are read under its lock). The window is checked by
// the caller; a second answer is refused here, and by the table's key.
export async function saveExit(
  tx: Tx,
  room: string,
  matchId: string,
  player: string,
  a: ExitAnswer,
  at: Date,
): Promise<StoredExit> {
  const [row] = await tx<Row[]>`
    INSERT INTO lab_exits (room, match_id, player, beliefs, why, said_in_person, at)
    VALUES (${room}, ${matchId}, ${player}, ${tx.json(a.beliefs)}, ${a.why},
      ${a.said_in_person}, ${at})
    ON CONFLICT (room, player) DO NOTHING
    RETURNING player, beliefs, why, said_in_person, at`;
  if (!row) throw refusal(409, "exit_answered");
  return stored(row);
}
