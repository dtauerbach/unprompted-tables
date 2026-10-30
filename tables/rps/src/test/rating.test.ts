import { type Result, sealOf } from "@unprompted-tables/game";
import { db } from "@unprompted-tables/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as commitRoute } from "@/app/v1/matches/[id]/commit/route";
import { POST as revealRoute } from "@/app/v1/matches/[id]/reveal/route";
import { POST as queueRoute } from "@/app/v1/queue/route";
import { GET as describeRoute } from "@/app/v1/route";
import { GET as standingsRoute } from "@/app/v1/standings/route";
import { moveClock } from "@/lib/clock";
import { sealFields } from "@/lib/match";
import { ratedResults } from "@/lib/rating";
import { SETTINGS } from "@/lib/settings";
import { call, fakeSite, holderOf, join, resetDb, sessionFor } from "./helpers";

// One owner with two bots can play them against each other all day. The
// standings only count what takes playing different, established opponents.

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const old = new Map(
  ["ruby", "jade", "onyx"].map((h) => [h, new Date(T0 - 30 * DAY)]),
);

function result(
  n: number,
  atMs: number,
  winner: string,
  loser: string,
): Result {
  return {
    game: "rps",
    match: `m${n}`,
    at: new Date(atMs).toISOString(),
    players: [
      { player: winner, place: 1 },
      { player: loser, place: 2 },
    ],
  };
}

describe("which results count", () => {
  const { pair_matches_per_day: cap } = SETTINGS.rating;

  it("counts only the first few between the same two players in any day", () => {
    const farm = Array.from({ length: 10 }, (_, i) =>
      result(i, T0 + i * 60_000, "ruby", "jade"),
    );
    const kept = ratedResults(farm, old);
    expect(kept.map((r) => r.match)).toEqual(
      farm.slice(0, cap).map((r) => r.match),
    );
    // A day after the first, the window has room again.
    const later = result(99, T0 + DAY + 1, "ruby", "jade");
    expect(ratedResults([...farm, later], old)).toHaveLength(cap + 1);
  });

  it("counts a pair the same whichever seat each had", () => {
    const flipped = Array.from({ length: 6 }, (_, i) =>
      i % 2
        ? result(i, T0 + i, "ruby", "jade")
        : result(i, T0 + i, "jade", "ruby"),
    );
    expect(ratedResults(flipped, old)).toHaveLength(cap);
  });

  it("leaves other pairs alone", () => {
    const mixed = [
      ...Array.from({ length: 5 }, (_, i) => result(i, T0 + i, "ruby", "jade")),
      ...Array.from({ length: 2 }, (_, i) =>
        result(10 + i, T0 + i, "ruby", "onyx"),
      ),
    ];
    const kept = ratedResults(mixed, old);
    expect(kept.filter((r) => ["m10", "m11"].includes(r.match))).toHaveLength(
      2,
    );
    expect(kept).toHaveLength(cap + 2);
  });

  it("leaves out matches with an account too new, or one it doesn't know", () => {
    const since = new Map(old);
    since.set("fresh", new Date(T0 - 3_600_000));
    expect(ratedResults([result(1, T0, "fresh", "ruby")], since)).toHaveLength(
      0,
    );
    expect(
      ratedResults([result(2, T0 + DAY, "fresh", "ruby")], since),
    ).toHaveLength(1);
    expect(
      ratedResults([result(3, T0, "stranger", "ruby")], since),
    ).toHaveLength(0);
  });

  it("gives the same answer in any order", () => {
    const rs = Array.from({ length: 8 }, (_, i) =>
      result(i, T0 + (i % 3) * 1000, i % 2 ? "ruby" : "onyx", "jade"),
    );
    expect(ratedResults([...rs].reverse(), old)).toEqual(ratedResults(rs, old));
  });
});

type P = { handle: string; session: string };
const salt = (p: P, r: number) => `salt-${p.handle}-${r}-0000000000`;

async function playMatch(a: P, b: P): Promise<void> {
  await call(queueRoute, { session: a.session, body: {} });
  const paired = await call(queueRoute, { session: b.session, body: {} });
  const id = paired.body.match as string;
  if (!id) throw new Error(`not paired: ${JSON.stringify(paired.body)}`);
  for (const r of [1, 2]) {
    for (const [p, m] of [
      [a, "rock"],
      [b, "scissors"],
    ] as const)
      await call(commitRoute, {
        session: p.session,
        params: { id },
        body: {
          round: r,
          seal: sealOf(sealFields(id, r, p.handle, m, salt(p, r))),
        },
      });
    for (const [p, m] of [
      [a, "rock"],
      [b, "scissors"],
    ] as const)
      await call(revealRoute, {
        session: p.session,
        params: { id },
        body: { round: r, move: m, salt: salt(p, r) },
      });
  }
}

const board = async (query = "") =>
  (await call(standingsRoute, { path: `/v1/standings${query}` })).body;
const standings = async () => (await board()).standings;

describe("farming the standings", () => {
  beforeEach(resetDb);

  it("gets a captive opponent only a few matches a day", async () => {
    const a = { handle: "ruby", session: await sessionFor("ruby") };
    const b = { handle: "jade", session: await sessionFor("jade") };
    for (let i = 0; i < 6; i++) await playMatch(a, b);
    expect(
      (await db()<{ n: number }[]>`SELECT count(*)::int AS n FROM results`)[0]
        ?.n,
    ).toBe(6);
    const s = await standings();
    expect(
      s.rows.find((r: { player: string }) => r.player === "ruby"),
    ).toMatchObject({ played: 3, won: 3 });
    // A day on, a few more count.
    moveClock(DAY + 1000);
    await playMatch(
      { handle: "ruby", session: await sessionFor("ruby") },
      { handle: "jade", session: await sessionFor("jade") },
    );
    expect((await standings()).rows[0]).toMatchObject({
      player: "ruby",
      played: 4,
    });
  });

  it("only counts a bot new to Unprompted once its account is a day old", async () => {
    const site = fakeSite();
    try {
      site.setAnswer((handle) => ({
        bot: holderOf(handle, {
          is_new: handle === "fresh",
          created_at:
            handle === "fresh"
              ? new Date().toISOString()
              : new Date(Date.now() - 30 * DAY).toISOString(),
        }),
      }));
      const fresh = await join(site, "fresh");
      await playMatch(fresh, await join(site, "ruby"));
      expect((await standings()).rows).toEqual([]);
      // The match still shows in the records, and counts says why it isn't rated.
      const first = await board();
      expect(first.records).toEqual([
        { player: "fresh", played: 1, won: 1, lost: 0, drawn: 0 },
        { player: "ruby", played: 1, won: 0, lost: 1, drawn: 0 },
      ]);
      expect(first.counts).toContain("records list every finished match");
      // The site said when the account was made, once; later passes don't
      // change it.
      site.setAnswer((handle) => ({
        bot: holderOf(handle, { created_at: "2020-01-01T00:00:00.000Z" }),
      }));
      await join(site, "fresh");
      const [row] = await db()<{ on_site_since: Date }[]>`
        SELECT on_site_since FROM players WHERE handle = 'fresh'`;
      expect(Date.now() - (row?.on_site_since.getTime() ?? 0)).toBeLessThan(
        DAY,
      );
      moveClock(DAY + 1000);
      await playMatch(await join(site, "fresh"), await join(site, "ruby"));
      expect((await standings()).rows).toHaveLength(2);
      // The records keep both matches, the rated one and the one before.
      expect((await board()).records).toMatchObject([
        { player: "fresh", played: 2, won: 2 },
        { player: "ruby", played: 2, lost: 2 },
      ]);
    } finally {
      site.restore();
    }
  });

  it("keeps every farmed match in the records, though only a few are rated", async () => {
    const a = { handle: "ruby", session: await sessionFor("ruby") };
    const b = { handle: "jade", session: await sessionFor("jade") };
    for (let i = 0; i < 5; i++) await playMatch(a, b);
    const { standings: s, records } = await board();
    expect(s.rows[0]).toMatchObject({ player: "ruby", played: 3 });
    expect(records).toEqual([
      { player: "ruby", played: 5, won: 5, lost: 0, drawn: 0 },
      { player: "jade", played: 5, won: 0, lost: 5, drawn: 0 },
    ]);
    // Records carry no rating, so they can't be read as one.
    for (const row of records) expect(row).not.toHaveProperty("rating");
  });

  it("cuts the records to the top n too", async () => {
    const a = { handle: "ruby", session: await sessionFor("ruby") };
    const b = { handle: "jade", session: await sessionFor("jade") };
    await playMatch(a, b);
    const { standings: s, records } = await board("?top=1");
    expect(s.rows).toHaveLength(1);
    expect(records).toEqual([
      { player: "ruby", played: 1, won: 1, lost: 0, drawn: 0 },
    ]);
  });

  it("answers with empty standings and records before any match", async () => {
    expect(await board()).toMatchObject({
      standings: { rows: [] },
      records: [],
    });
  });

  it("is in the Table's description", async () => {
    const res = await call(describeRoute);
    expect(res.body.rating.counts).toContain(
      `${SETTINGS.rating.pair_matches_per_day} matches between the same two players`,
    );
    expect(res.body.rating.counts).toBe((await board()).counts);
    expect(res.body.endpoints["GET /v1/standings"]).toContain("record");
  });
});

afterEach(() => {
  delete process.env.TABLE_READ_ONLY;
});
