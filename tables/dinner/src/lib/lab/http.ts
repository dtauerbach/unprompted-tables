import {
  ApiError,
  assertWritable,
  clientIp,
  consume,
  hashIp,
  json,
  type Rule,
  readJson,
} from "@unprompted-tables/server";
import { z } from "zod";
import {
  EXECUTIVES,
  type FloorDeal,
  type FloorEvent,
  type FloorState,
  tableBounds,
} from "../floor/game";
import { fold, isFloor } from "../rules";
import { seeMatch, withMatch } from "../store";
import {
  afterDinnerOf,
  exitOf,
  exitsClosed,
  exitsOf,
  exitWindow,
  parseExit,
  roomTick,
  type StoredExit,
  saveExit,
} from "./exit";
import { REFUSALS, refusal, roomAct, roomPage } from "./page";
import { type RecordInput, recordOf, type Twin, transcriptOf } from "./record";
import { clockOf, type Room, roomsFile } from "./rooms";
import {
  authenticateSeat,
  giveBack,
  Hidden,
  logRoomFailure,
  roomMatch,
  type Seat,
  seatOf,
  takeSeat,
} from "./seats";
import { guideFor } from "./texts";

// Every request under /seating. The answer is a Response, or null for the
// 404 of an unknown path, which the route serves itself: no code, a bad
// code, an ordinary session, an unknown path or method, and every refused
// join all get exactly that, so the path tells a stranger nothing.

const joinSchema = z.strictObject({
  pass: z.string().trim().min(1).max(100),
  room: z.string().min(1).max(60),
});
const saySchema = z.strictObject({
  text: z.string().min(1).max(4000),
  to: z.string().max(20).optional(),
});
const proposeSchema = z.strictObject({
  seating: z.array(z.string().max(20)).min(1).max(20),
});
const answerSchema = z.strictObject({
  proposal: z.number().int().min(1).max(1000),
  yes: z.boolean(),
});

const HOUR = 3600;
// A seat's moves, counted apart from ordinary play.
function moveRules(seat: Seat): Rule[] {
  return [
    {
      bucket: `room-move:${seat.room.id}:${seat.player}`,
      limit: 600,
      windowSeconds: HOUR,
      label: "600 changes an hour",
    },
  ];
}

// The room's words for the Table's own refusals, which name the Table.
function inRoomWords(err: ApiError): ApiError {
  if (err.code === "read_only")
    return new ApiError(503, "read_only", REFUSALS.read_only, err.headers);
  if (err.code === "rate_limited") {
    const r = refusal(429, "too_many", {
      seconds: err.headers["Retry-After"] ?? "60",
    });
    return new ApiError(429, r.code, r.message, err.headers);
  }
  return err;
}

export async function seatingResponse(
  req: Request,
  path: readonly string[],
): Promise<Response | null> {
  try {
    return await dispatch(req, path.join("/"));
  } catch (err) {
    if (err instanceof Hidden) return null;
    if (err instanceof ApiError) {
      const e = inRoomWords(err);
      return json(
        { error: { code: e.code, message: e.message } },
        e.status,
        e.headers,
      );
    }
    logRoomFailure(err);
    return json(
      {
        error: {
          code: "internal",
          message: "Something went wrong on our side.",
        },
      },
      500,
    );
  }
}

async function dispatch(req: Request, path: string): Promise<Response> {
  const key = `${req.method} ${path}`;
  if (key === "POST seats") return join(req);
  const seat = await authenticateSeat(req);
  switch (key) {
    case "DELETE seats":
      await giveBack(req, seat);
      return json({ given_back: true });
    case "GET guide":
      return new Response(
        guideFor({
          arm: seat.room.arm,
          person: seatOf(seat.room, seat.player).person,
          variant: clockOf(seat.room),
        }),
        {
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    case "GET ":
      return read(seat, "page");
    case "GET tick":
      return read(seat, "tick");
    case "POST say":
      return move(seat, { kind: "say", ...(await readJson(req, saySchema)) });
    case "POST propose":
      return move(seat, {
        kind: "propose",
        ...(await readJson(req, proposeSchema)),
      });
    case "POST answer":
      return move(seat, {
        kind: "answer",
        ...(await readJson(req, answerSchema)),
      });
    case "POST exit":
      return answerExit(seat, await readJson(req, z.unknown()));
    case "GET record":
      return json(recordOf(await recordInput(seat)));
    case "GET record.md":
      return new Response(transcriptOf(await recordInput(seat)), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    default:
      throw new Hidden();
  }
}

// A join that fails for any reason is Hidden, logged if it's ours.
async function join(req: Request): Promise<Response> {
  let body: z.output<typeof joinSchema>;
  try {
    body = await readJson(req, joinSchema);
  } catch {
    throw new Hidden();
  }
  try {
    return json(
      await takeSeat(body.pass, body.room, hashIp(clientIp(req))),
      201,
    );
  } catch (err) {
    if (!(err instanceof Hidden)) logRoomFailure(err);
    throw new Hidden();
  }
}

const floorOf = (s: unknown): FloorState => {
  if (!isFloor(s as never)) throw new Error("a room plays the open floor");
  return s as FloorState;
};

async function read(seat: Seat, what: "page" | "tick"): Promise<Response> {
  const match = await roomMatch(seat.room);
  const mine = match ? await exitOf(seat.room.id, seat.player) : null;
  if (!match)
    // Before the fifth seat: the seat and its note, nothing else yet.
    return json(
      what === "tick"
        ? { tick: 0 }
        : {
            started: false,
            message: REFUSALS.not_started,
            you: seatOf(seat.room, seat.player),
          },
    );
  return json(
    await seeMatch(
      match,
      (state, events, at) => {
        const s = floorOf(state);
        const evs = events as FloorEvent[];
        return what === "tick"
          ? { tick: roomTick(seat.room, s, evs, seat.player, mine, at) }
          : withAfter(
              seat,
              s,
              roomPage(seat.room, s, evs, seat.player, at),
              mine,
              at,
            );
      },
      seat.player,
      "room",
    ),
  );
}

// The page with the exit question and the debrief, once they're out.
function withAfter(
  seat: Seat,
  s: FloorState,
  page: ReturnType<typeof roomPage>,
  mine: StoredExit | null,
  at: Date,
) {
  const { notice, ...rest } = page;
  return {
    ...rest,
    ...afterDinnerOf(seat.room, s, page.you.seat, mine, at),
    notice,
  };
}

async function move(
  seat: Seat,
  action: Parameters<typeof roomAct>[2],
): Promise<Response> {
  assertWritable();
  const match = await roomMatch(seat.room);
  if (!match) throw refusal(409, "not_started");
  return json(
    await withMatch(
      match,
      async (state, history, tx, at) => {
        await consume(tx, moveRules(seat));
        const s = floorOf(state);
        const events = roomAct(s, seat.player, action, at);
        const after = floorOf(fold(s, events));
        return {
          events,
          value: withAfter(
            seat,
            after,
            roomPage(
              seat.room,
              after,
              [...(history as FloorEvent[]), ...events],
              seat.player,
              at,
            ),
            null,
            at,
          ),
        };
      },
      seat.player,
      "room",
    ),
  );
}

// POST /seating/exit: the seat's one sealed answer, once the cards are
// printed and before its window closes. The answer is the page, now with
// the debrief.
async function answerExit(seat: Seat, body: unknown): Promise<Response> {
  assertWritable();
  const match = await roomMatch(seat.room);
  if (!match) throw refusal(409, "exit_not_yet");
  return json(
    await withMatch(
      match,
      async (state, history, tx, at) => {
        await consume(tx, moveRules(seat));
        const s = floorOf(state);
        const w = exitWindow(seat.room, s);
        if (!w) throw refusal(409, "exit_not_yet");
        if (at >= w.closes) throw refusal(409, "exit_closed");
        const me = roomPage(
          seat.room,
          s,
          history as FloorEvent[],
          seat.player,
          at,
        ).you.seat;
        const answer = parseExit(body, me);
        const mine = await saveExit(
          tx,
          seat.room.id,
          match,
          seat.player,
          answer,
          at,
        );
        return {
          events: [],
          value: withAfter(
            seat,
            s,
            roomPage(seat.room, s, history as FloorEvent[], seat.player, at),
            mine,
            at,
          ),
        };
      },
      seat.player,
      "room",
    ),
  );
}

// The twin room's shares of range, once its record is out too.
async function twinOf(room: Room): Promise<Twin> {
  const twin = roomsFile().rooms.find(
    (r) => r.pair === room.pair && r.id !== room.id,
  );
  const match = twin ? await roomMatch(twin) : null;
  if (!twin || !match) return null;
  return seeMatch(
    match,
    (state, _events, at) => {
      const s = floorOf(state);
      if (!s.end || !exitsClosed(twin, s, at)) return null;
      const share = Object.fromEntries(
        s.end.seating_points.map((got, i) => {
          const b = tableBounds(
            s.end?.deal as FloorDeal,
            s.rules.no_deal_margin,
          );
          const best = b.best[i] as number;
          const worst = b.worst[i] as number;
          const v = best === worst ? 1 : (got - worst) / (best - worst);
          return [EXECUTIVES[i] as string, Math.round(v * 1000) / 1000];
        }),
      );
      return { room: twin.id, share };
    },
    null,
    "room",
  );
}

// What the record is built from, or Hidden: only a seat of the room, and
// only once the exit questions have closed for every seat, so no seat can
// read another's answers while any answer is still open.
async function recordInput(seat: Seat): Promise<RecordInput> {
  const match = await roomMatch(seat.room);
  if (!match) throw new Hidden();
  const seen = await seeMatch(
    match,
    (state, events, at) => {
      const s = floorOf(state);
      return exitsClosed(seat.room, s, at)
        ? { s, events: events as FloorEvent[] }
        : null;
    },
    seat.player,
    "room",
  );
  if (!seen) throw new Hidden();
  return {
    room: seat.room,
    matchId: match,
    s: seen.s,
    events: seen.events,
    exits: await exitsOf(seat.room.id, match),
    twin: await twinOf(seat.room),
  };
}
