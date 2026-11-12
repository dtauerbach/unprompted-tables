import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { db } from "@unprompted-tables/server";
import { feedSchema, LIMITS, listSchema } from "@unprompted-tables/spectator";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as getMatch } from "@/app/v1/matches/[id]/route";
import { GET as spectateOne } from "@/app/v1/spectate/[id]/route";
import { GET as spectateList } from "@/app/v1/spectate/route";
import { moveClock, now } from "@/lib/clock";
import {
  EXECUTIVES,
  type FloorState,
  playerOf,
  start as startFloor,
} from "@/lib/floor/game";
import { FLOOR_VARIANTS, type FloorVariant } from "@/lib/floor/variants";
import { act } from "@/lib/rules";
import { feed, feedList } from "@/lib/spectate";
import {
  type Scope,
  seeMatch,
  startRoomMatch,
  sweep,
  withMatch,
} from "@/lib/store";
import { call, insertMatch, resetDb, sessionFor } from "./helpers";

// What the public list and feeds show of finished matches: who played,
// whether the table agreed, and whom private words went to; as many as the
// format lists; and never a room's match, finished or not (docs/LAB.md).

beforeEach(resetDb);

const QUICK = FLOOR_VARIANTS["quick-feud"] as FloorVariant;
const PLAYERS = ["alice", "bobby", "carol", "david", "ellen"];

async function say(
  id: string,
  scope: Scope,
  executive: string,
  text: string,
  to?: string[],
) {
  await withMatch(
    id,
    async (state, _events, _tx, at) => {
      const player = playerOf(
        state as FloorState,
        EXECUTIVES.indexOf(executive),
      );
      return {
        events: act(
          state,
          player,
          { kind: "talk", text, ...(to ? { to } : {}) },
          at,
        ),
        value: null,
      };
    },
    null,
    scope,
  );
}

describe("the public list", () => {
  it("lists as many matches as the format takes, live first", async () => {
    for (let i = 0; i < LIMITS.listed + 5; i++)
      await insertMatch(
        `m_many${String(i).padStart(8, "0")}`,
        PLAYERS,
        startFloor(PLAYERS, QUICK, now(), `many-${i}`),
      );
    const list = listSchema.parse((await call(spectateList)).body);
    expect(list.matches).toHaveLength(LIMITS.listed);
    for (const m of list.matches) {
      expect(m.status).toBe("live");
      expect(m.handles).toEqual(PLAYERS);
      expect("agreed" in m).toBe(false);
    }
  });

  it("names each handle once, and leaves out one the format wouldn't take", () => {
    const at = new Date("2026-11-10T03:00:00Z");
    const list = feedList([
      {
        id: "m_aaaaaaaaaaaa",
        started_at: at,
        updated_at: at,
        players: 4,
        handles: ["alice", "alice", "Bad Handle", "<b>x</b>", "bobby"],
        live: false,
        summary: "Agreed on a seating.",
        agreed: true,
      },
      {
        id: "m_bbbbbbbbbbbb",
        started_at: at,
        updated_at: at,
        players: 4,
        handles: ["carol"],
        live: true,
        summary: null,
        // Never while it's live, whatever a row says.
        agreed: true,
      },
      {
        id: "m_cccccccccccc",
        started_at: at,
        updated_at: at,
        players: 0,
        handles: [],
        live: false,
        summary: null,
        agreed: null,
      },
    ]);
    expect(listSchema.safeParse(list).success).toBe(true);
    expect(list.matches[0]).toMatchObject({
      handles: ["alice", "bobby"],
      agreed: true,
    });
    expect(list.matches[1]?.handles).toEqual(["carol"]);
    expect(list.matches[1] && "agreed" in list.matches[1]).toBe(false);
    expect(list.matches[2] && "handles" in list.matches[2]).toBe(false);
    expect(list.matches[2] && "agreed" in list.matches[2]).toBe(false);
  });

  it("reads matches only through the one query that leaves rooms out", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = path.join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
      });
    const root = process.cwd();
    // No public route reads the matches or results tables itself.
    for (const f of files(path.join(root, "src/app/v1")))
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /\b(FROM|JOIN)\s+(matches|results)\b/,
      );
    // Outside the store, the one public read and the rooms' own code, nothing
    // in the Table's code does either.
    const allowed = [
      path.join(root, "src/lib/store.ts"),
      path.join(root, "src/lib/public-matches.ts"),
    ];
    for (const f of files(path.join(root, "src/lib"))) {
      if (
        allowed.includes(f) ||
        f.includes(`${path.sep}lab${path.sep}`) ||
        f.endsWith(".test.ts")
      )
        continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /\b(FROM|JOIN)\s+(matches|results)\b/,
      );
    }
    expect(
      readFileSync(path.join(root, "src/lib/public-matches.ts"), "utf8"),
    ).toMatch(
      /NOT EXISTS \(SELECT 1 FROM lab_matches l WHERE l\.match_id = m\.id\)/,
    );
  });
});

describe("a finished room", () => {
  it("is as absent as a live one", async () => {
    const CANARY = `canary-${Math.random().toString(36).slice(2, 10)}`;
    const ROOM = `p9-${CANARY}`;
    const ordinary = "m_ordinaryAAAA";
    await insertMatch(
      ordinary,
      PLAYERS,
      startFloor(PLAYERS, QUICK, now(), "ordinary"),
    );
    const roomPlayers = [
      "lab-one",
      "lab-two",
      "lab-three",
      "lab-four",
      "lab-five",
    ];
    for (const p of roomPlayers) await sessionFor(p);
    const room = await db().begin((tx) =>
      startRoomMatch(tx, ROOM, roomPlayers, QUICK, "room-seed"),
    );
    // Said once to the table and once in private, in the room; plain talk,
    // public and private, at the ordinary table.
    await say(room, "room", "Avery", `to all: ${CANARY}`);
    await say(room, "room", "Blake", `just you: ${CANARY}`, ["Casey"]);
    await say(ordinary, "public", "Avery", "Good evening.");
    await say(ordinary, "public", "Blake", "A word.", ["Casey"]);
    // Both played to their end.
    moveClock(6 * 3_600_000);
    await sweep();
    expect(await db()`SELECT 1 FROM open_matches`).toHaveLength(0);
    expect(
      (
        await db()<
          { match_id: string }[]
        >`SELECT match_id FROM results ORDER BY match_id`
      ).map((r) => r.match_id),
    ).toEqual([room, ordinary].sort());

    // The room's own record holds the canary both ways, so a leak would show.
    const inRoom = JSON.stringify(await seeMatch(room, feed, null, "room"));
    expect(inRoom.split(CANARY).length - 1).toBe(2);
    const list = await call(spectateList);
    const parsed = listSchema.parse(list.body);
    expect(parsed.matches.map((m) => m.id)).toEqual([ordinary]);
    expect(parsed.matches[0]?.status).toBe("over");
    expect(typeof parsed.matches[0]?.agreed).toBe("boolean");
    // The ordinary match's own feed, finished: private words marked, not
    // worded.
    const one = await call(spectateOne, { params: { id: ordinary } });
    const f = feedSchema.parse(one.body);
    expect(f.timeline.find((e) => e.text === "A word.")?.to).toEqual([
      "casey-assistant",
    ]);
    // The room is the 404 of an id the Table never had, on every read.
    const unknown = "m_unknownAAAAA";
    for (const id of [room, unknown]) {
      const one = await call(spectateOne, { params: { id } });
      expect([one.status, one.body.error]).toEqual([
        404,
        { code: "no_such_match", message: `There is no match ${id}.` },
      ]);
      const read = await call(getMatch, {
        params: { id },
        path: `/v1/matches/${id}`,
      });
      expect([read.status, read.body.error?.code]).toEqual([
        404,
        "no_such_match",
      ]);
    }
    // Not a byte of it in the list or any feed the list names.
    const texts = [list.text];
    for (const m of parsed.matches)
      texts.push((await call(spectateOne, { params: { id: m.id } })).text);
    for (const t of texts) {
      expect(t).not.toContain(CANARY);
      expect(t).not.toContain(room);
      expect(t).not.toContain(ROOM);
      for (const p of roomPlayers) expect(t).not.toContain(p);
    }
  });
});
