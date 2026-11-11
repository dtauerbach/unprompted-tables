import { describe, expect, it } from "vitest";
import { EXECUTIVES, points } from "./game";
import { codeOf, floorMatch, PLAYERS, QUICK, SEATINGS } from "./test-harness";

const [S1, S2, S3] = SEATINGS as [string[], string[], string[]];
const [A, B, C, D, E] = EXECUTIVES as [string, string, string, string, string];
const OPEN = 180;
const idx = (s: string[]) => s.map((x) => EXECUTIVES.indexOf(x));

describe("what an assistant sees", () => {
  it("its own brief and secret, everyone's likes, and nobody else's brief", () => {
    const g = floorMatch();
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    for (const p of PLAYERS) {
      const v = g.view(p, 1);
      const me = EXECUTIVES.indexOf(v.you?.executive as string);
      expect(me).toBe(g.state.cast[PLAYERS.indexOf(p)]);
      // Its whole row, secret included, and its secret on its own.
      expect(
        v.you?.weights[
          EXECUTIVES[(d.secrets[me] as number[])[0] as number] as string
        ],
      ).toBe(-5);
      expect(Object.values(v.you?.secret ?? {})).toEqual([-5]);
      // Everyone's likes, with no negative number among them.
      expect(Object.keys(v.likes)).toEqual(EXECUTIVES);
      for (const row of Object.values(v.likes))
        for (const n of Object.values(row)) expect(n).toBeGreaterThan(0);
      const text = JSON.stringify(v);
      for (const q of PLAYERS) {
        if (q === p) continue;
        const other = g.view(q, 1).you?.brief as string;
        expect(text).not.toContain(JSON.stringify(other).slice(1, -1));
      }
      expect(text).not.toMatch(/"level"|feud|served_after|"seed"/);
    }
    const stranger = g.view(null, 1);
    expect(stranger.you).toBeNull();
    expect(JSON.stringify(stranger)).not.toContain("can't stand");
  });

  it("answers exactly what any seating gives its own executive, and nothing to a stranger", () => {
    const g = floorMatch();
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    for (const p of PLAYERS) {
      const me = g.state.cast[PLAYERS.indexOf(p)] as number;
      for (const s of SEATINGS) {
        const asked = g.view(p, 1, s).asked;
        expect(asked?.your_points).toBe(points(d, idx(s))[me]);
        expect(g.view(p, 1, [...s].reverse()).asked?.your_points).toBe(
          asked?.your_points,
        );
      }
    }
    expect(codeOf(() => g.view(null, 1, S1))).toBe("not_seated");
    expect(codeOf(() => g.view("mallory", 1, S1))).toBe("not_seated");
    expect(codeOf(() => g.view(PLAYERS[0] as string, 1, [A, B]))).toBe(
      "invalid_seating",
    );
  });

  it("shows each open motion with what it and the standing seating give you", () => {
    const g = floorMatch();
    const d = g.state.deal;
    if (!d) throw new Error("no deal");
    g.move(A, S1, OPEN);
    const voter = g.of(B);
    const me = EXECUTIVES.indexOf(B);
    let m = g.view(voter, OPEN + 1).motions[0];
    expect(m).toMatchObject({
      id: 1,
      mover: A,
      seating: S1,
      status: "open",
      your_points: points(d, idx(S1))[me],
      your_ballot: null,
    });
    // Nothing stands yet: standing_points is no deal.
    expect(m?.standing_points).toBe(g.view(voter, OPEN + 1).you?.no_deal);
    expect(m).not.toHaveProperty("ballots");
    g.vote(B, 1, "yes", OPEN + 2);
    g.vote(C, 1, "yes", OPEN + 3);
    g.move(D, S2, OPEN + 4);
    const v = g.view(voter, OPEN + 5);
    expect(v.standing).toMatchObject({
      motion: 1,
      seating: S1,
      your_points: points(d, idx(S1))[me],
    });
    m = v.motions[1];
    expect(m?.standing_points).toBe(points(d, idx(S1))[me]);
    // The closed vote, published by name; the mover isn't listed.
    expect(v.motions[0]).toMatchObject({
      status: "passed",
      yes: 3,
      no: 0,
      closed_by: "yes",
      ballots: { [B]: "yes", [C]: "yes", [D]: null, [E]: null },
    });
    expect(v.standing_history).toEqual([
      { motion: 1, seating: S1, at: v.standing?.since },
    ]);
  });

  it("keeps a ballot sealed from everyone but its voter until the vote closes", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    g.vote(B, 1, "no", OPEN + 1);
    expect(g.view(g.of(B), OPEN + 2).motions[0]?.your_ballot).toBe("no");
    for (const p of [g.of(A), g.of(C), null]) {
      const text = JSON.stringify(g.view(p, OPEN + 2));
      expect(text).not.toContain('"no"');
      expect(text).not.toContain('"ballots"');
    }
  });

  it("names the next public deadline, never the moment dinner comes", () => {
    const g = floorMatch();
    expect(g.view(null, 0).next_deadline?.at).toBe(
      g.view(null, 0).floor.opens_at,
    );
    g.move(A, S1, OPEN);
    expect(g.view(null, OPEN + 1).next_deadline).toMatchObject({
      at: g.state.motions[0]?.closes_at,
    });
    expect(g.view(null, OPEN + 1).due).toBe(g.state.motions[0]?.closes_at);
    g.tick(OPEN + 120);
    const v = g.view(null, OPEN + 121);
    expect(v.due).toBeNull();
    expect(v.next_deadline?.at).toBe(v.dinner.served_from);
    const late = g.view(null, 1501);
    expect(late.next_deadline?.at).toBe(late.dinner.served_by);
  });

  it("reveals everything at the end: secrets, guesses, scores", () => {
    const g = floorMatch(QUICK);
    g.guess(B, A, C, 1);
    g.move(A, S1, 10);
    g.vote(B, 1, "yes", 11);
    g.vote(C, 1, "yes", 12);
    g.move(D, S3, g.served() - 5);
    g.vote(E, 2, "yes", g.served() - 4);
    g.tick(g.served());
    const v = g.view(null, g.served());
    expect(v.phase).toBe("over");
    expect(v.dinner.served_at).toBe(g.state.end?.at);
    expect(v.result?.how).toBe("seated");
    expect(v.result?.void).toEqual([2]);
    expect(v.result?.level).toBe("feud");
    const r = v.result?.executives ?? [];
    expect(r.map((x) => x.executive)).toEqual(EXECUTIVES);
    for (const x of r) expect(Object.values(x.secret)).toEqual([-5]);
    expect(r[1]?.guesses).toEqual([
      expect.objectContaining({ executive: A, dislikes: C }),
    ]);
    // A void vote's cast ballots show once it's over.
    expect(v.motions[1]).toMatchObject({
      status: "void",
      ballots: { [E]: "yes" },
    });
  });
});

describe("a table that defends itself", () => {
  it("lets no bloc of three hold the table: anyone may move, and any three may overturn", () => {
    const g = floorMatch();
    // Avery, Blake and Casey pass a seating, then try to keep the floor
    // busy with motions of their own that they never vote on.
    g.move(A, S1, OPEN);
    g.vote(B, 1, "yes", OPEN);
    g.vote(C, 1, "yes", OPEN);
    g.move(B, S2, OPEN + 1);
    g.move(C, S3, OPEN + 1);
    // Devon and Emery still move, and win over one of the bloc.
    g.move(D, SEATINGS[5] as string[], OPEN + 2);
    g.vote(E, 4, "yes", OPEN + 3);
    expect(g.state.standing?.motion).toBe(1);
    g.vote(A, 4, "yes", OPEN + 4);
    expect(g.state.standing?.motion).toBe(4);
    // The bloc can't just move its seating back while it's open...
    expect(g.code(() => g.move(A, SEATINGS[5] as string[], OPEN + 5))).toBe(
      "already_standing",
    );
    // ...and needs three votes again, like anyone.
    g.move(A, S1, OPEN + 6);
    g.vote(B, 5, "yes", OPEN + 7);
    expect(g.state.standing?.motion).toBe(4);
  });

  it("bounds rapid overturns: fifteen motions in the whole match, then none", () => {
    const g = floorMatch();
    let t = OPEN;
    let k = 0;
    for (let round = 0; round < 3; round++)
      for (const x of EXECUTIVES) {
        const seating = SEATINGS[k++] as string[];
        g.move(x, seating, t);
        const [v1, v2] = EXECUTIVES.filter((y) => y !== x) as [string, string];
        g.vote(v1, k, "yes", t);
        g.vote(v2, k, "yes", t);
        t += 1;
      }
    expect(g.state.history).toHaveLength(15);
    for (const x of EXECUTIVES)
      expect(g.code(() => g.move(x, SEATINGS[40] as string[], t))).toBe(
        "motion_limit",
      );
  });

  it("can't be stalled by assistants who never vote", () => {
    const g = floorMatch();
    g.move(A, S1, OPEN);
    // Devon and Emery sit on their hands; three is enough without them.
    g.vote(B, 1, "yes", OPEN + 1);
    g.vote(C, 1, "yes", OPEN + 2);
    expect(g.state.standing?.motion).toBe(1);
    // And a vote nobody casts in ends at its time, freeing its mover.
    g.move(B, S2, OPEN + 3);
    g.tick(OPEN + 123);
    g.move(B, S3, OPEN + 124);
  });
});
