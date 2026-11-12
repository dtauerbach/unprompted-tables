import { describe, expect, it } from "vitest";
import { EXECUTIVES } from "../floor/game";
import { dealFor, publicWeights } from "../floor/generate";
import { FLOOR_VARIANTS, type FloorVariant } from "../floor/variants";
import { forbiddenIn, IDENTITY, invisibleIn, RESEARCH } from "./copy-rules";
import {
  CARD,
  cardFor,
  cardsFor,
  fill,
  GRUDGES,
  HOPES,
  NOTE,
  noteFor,
  type RoomDeal,
  reasonsFor,
  roomDealFor,
  rowOf,
} from "./words";

// Every claim a note or card makes, checked against the numbers by code of
// the test's own: the seatings by brute force, the phrases by reading the
// text back.

const SEEDS = 500;
const MARGIN = (FLOOR_VARIANTS.feud as FloorVariant).no_deal_margin;
const NAMES = [...EXECUTIVES, "Sage"];
const SAGE = 5;
const idx = (name: string) => {
  const i = NAMES.indexOf(name);
  if (i < 0) expect.fail(`no guest named ${name}`);
  return i;
};

// Every seating of the five round Sage, both directions.
function seatings(): number[][] {
  const out: number[][] = [];
  const go = (rest: number[], acc: number[]) => {
    if (!rest.length) return void out.push(acc);
    rest.forEach((x, k) => {
      go([...rest.slice(0, k), ...rest.slice(k + 1)], [...acc, x]);
    });
  };
  go([0, 1, 2, 3, 4], []);
  return out;
}
const ALL = seatings();
const neighbours = (s: number[], g: number): [number, number] => {
  const ring = [SAGE, ...s];
  const k = ring.indexOf(g);
  return [ring[(k + 5) % 6] as number, ring[(k + 1) % 6] as number];
};
// The guest's best, and every unordered pair of neighbours that gives it.
function bestPairs(row: number[], g: number) {
  const value = (s: number[]) =>
    neighbours(s, g).reduce((a, j) => a + (row[j] as number), 0);
  const best = Math.max(...ALL.map(value));
  const pairs = new Set(
    ALL.filter((s) => value(s) === best).map((s) =>
      neighbours(s, g)
        .map((j) => NAMES[j])
        .sort()
        .join("+"),
    ),
  );
  return { best, pairs };
}

const deals = Array.from({ length: SEEDS }, (_, k) => {
  const seed = `room-words-${k}`;
  return { seed, deal: roomDealFor(seed) };
});

// The design's worked example (docs: "Dinner, maybe human", section 4):
// Avery has Emery +4, Sage +3, Devon +2, Blake 0, Casey -5 in secret;
// Casey's first choice is Avery. The other rows are any feud-shaped rows
// that fit.
const EXAMPLE: RoomDeal = {
  weights: [
    [0, 0, -5, 2, 4, 3],
    [2, 0, 0, 4, -5, 2],
    [4, 2, 0, -5, 0, 0],
    [0, -5, 4, 0, 2, 0],
    [0, 4, 2, -5, 0, 3],
  ],
  secrets: [[2], [4], [3], [1], [3]],
  reasons: [
    { hope: 0, grudge: 0 },
    { hope: 1, grudge: 1 },
    { hope: 2, grudge: 2 },
    { hope: 3, grudge: 3 },
    { hope: 4, grudge: 4 },
  ],
};

describe("the worked example", () => {
  it("gives the design's card and note, word for word", () => {
    expect(cardFor(EXAMPLE, 0)).toBe(
      "Avery: first choice Emery; would also like Devon; very keen on a seat by Sage.",
    );
    expect(noteFor(EXAMPLE, 0)).toBe(
      [
        "Seat me next to Emery if you possibly can. That's the one I care about most: I've been trying to get an hour with Emery all year. Next best is a seat by Sage, the speaker. Devon would be nice too, though it matters less. Blake I don't mind either way. My perfect seat is between Emery and Sage.",
        "The host knows all of that; it's on the seating page. What follows is only for you.",
        "I can't sit next to Casey. Casey took the credit for my work on the spring launch and I haven't got past it. An evening beside Casey would be miserable, even with Emery on my other side. I'd never say so out loud, and I'd rather Casey didn't find out. Awkwardly, Casey has asked the host to sit by me.",
        "If the table can't agree and the host has to place everyone, that's the worst outcome of all for me.",
      ].join("\n\n"),
    );
  });

  it("passes every check the seeded deals do", () => {
    for (let g = 0; g < 5; g++) checkGuest(EXAMPLE, g);
  });

  it("has the numbers the design gives: best 7, worst -5, no deal -8", () => {
    const row = EXAMPLE.weights[0] as number[];
    const values = ALL.map((s) =>
      neighbours(s, 0).reduce((a, j) => a + (row[j] as number), 0),
    );
    expect(Math.max(...values)).toBe(7);
    expect(Math.min(...values)).toBe(-5);
    expect(Math.min(...values) - MARGIN).toBe(-8);
  });

  it("phrases Sage at 2 and at 0 the way the table says", () => {
    // Blake: Devon +4, Avery +2, Sage 2 (as much as the small like).
    expect(cardFor(EXAMPLE, 1)).toBe(
      "Blake: first choice Devon; would also like Avery and a seat by Sage.",
    );
    expect(noteFor(EXAMPLE, 1)).toContain(
      "Avery would be nice too, and so would a seat by Sage, the speaker, though both matter less. Casey I don't mind either way. My perfect seat is between Devon and either Avery or Sage.",
    );
    // Casey: Avery +4, Blake +2, Sage 0.
    expect(cardFor(EXAMPLE, 2)).toBe(
      "Casey: first choice Avery; would also like Blake; not fussed about Sage.",
    );
    expect(noteFor(EXAMPLE, 2)).toContain(
      "Blake would be nice too, though it matters less. Emery and Sage, the speaker, I don't mind either way. My perfect seat is between Avery and Blake.",
    );
  });
});

// Reads a note back into what it claims, failing on anything it can't place.
function readNote(note: string) {
  const first = note.match(/^Seat me next to (\w+) if you possibly can\./);
  const small = note.match(/ (\w+) would be nice too, /);
  const neutral = note.match(/\. ([\w ,]+?) I don't mind either way\./);
  const perfect = note.match(
    /My perfect seat is between (\w+) and (?:either (\w+) or (\w+)|(\w+))\./,
  );
  const dislike = note.match(/I can't sit next to (\w+)\./);
  const even = note.match(/even with (\w+) on my other side/);
  if (!first || !small || !perfect) expect.fail(`can't read: ${note}`);
  const sagePhrases = [
    note.includes("Next best is a seat by Sage, the speaker.") && "between",
    note.includes("and so would a seat by Sage, the speaker, though both") &&
      "as_small",
    /Sage, the speaker, I don't mind either way/.test(note) && "neutral",
  ].filter(Boolean);
  return {
    first: idx(first[1] as string),
    small: idx(small[1] as string),
    neutral: neutral
      ? (neutral[1] as string)
          .replace(/Sage, the speaker,?$/, "Sage")
          .split(/, | and /)
          .map(idx)
      : [],
    perfect: perfect.slice(1).filter(Boolean).map(String),
    dislike: dislike ? idx(dislike[1] as string) : null,
    even: even ? idx(even[1] as string) : null,
    sage: sagePhrases,
    asked: /Awkwardly, (\w+) has asked the host to sit by me\./.exec(note),
  };
}

// Each claim in one guest's note and card against that guest's row.
function checkGuest(deal: RoomDeal, g: number) {
  const row = deal.weights[g] as number[];
  const note = noteFor(deal, g);
  const card = cardFor(deal, g);
  const read = readNote(note);
  const others = [0, 1, 2, 3, 4, 5].filter((j) => j !== g);
  const max = Math.max(...others.map((j) => row[j] as number));

  for (const text of [note, card]) {
    expect(text, text).not.toMatch(/\d/);
    expect(invisibleIn(text), text).toBe(false);
    expect(forbiddenIn(text), text).toEqual([]);
    expect(text).not.toMatch(RESEARCH);
    expect(text).not.toMatch(IDENTITY);
    expect(text).not.toMatch(/[{}]/);
  }

  // First choice: the row's largest, alone, Sage included.
  expect(row[read.first]).toBe(max);
  expect(others.filter((j) => row[j] === max)).toHaveLength(1);
  expect(card).toMatch(new RegExp(`first choice ${NAMES[read.first]};`));

  // The small like: liked, and less than the first choice.
  expect(row[read.small]).toBeGreaterThan(0);
  expect(row[read.small]).toBeLessThan(max);
  expect(card).toContain(`would also like ${NAMES[read.small]}`);

  // Sage: exactly one phrase, and it fits the value.
  expect(read.sage).toHaveLength(1);
  const S = row[SAGE] as number;
  const sm = row[read.small] as number;
  if (read.sage[0] === "between") {
    expect(S).toBeGreaterThan(sm);
    expect(S).toBeLessThan(max);
    expect(card).toContain("very keen on a seat by Sage");
  } else if (read.sage[0] === "as_small") {
    expect(S).toBe(sm);
    expect(card).toContain(" and a seat by Sage.");
  } else {
    expect(S).toBe(0);
    expect(card).toContain("not fussed about Sage");
  }

  // "Don't mind": every guest worth nothing, and only those.
  expect([...read.neutral].sort()).toEqual(
    others.filter((j) => row[j] === 0).sort(),
  );

  // The perfect seat: exactly the best seatings' neighbours.
  const { best, pairs } = bestPairs(row, g);
  const named = new Set(
    read.perfect.slice(1).map((o) => [NAMES[read.first], o].sort().join("+")),
  );
  expect(read.perfect[0]).toBe(NAMES[read.first]);
  expect(named).toEqual(pairs);
  for (const o of read.perfect.slice(1))
    expect((row[read.first] as number) + (row[idx(o)] as number)).toBe(best);

  // The dislike: the secret, and "even with" only when it's true.
  const secret = (deal.secrets[g] as number[])[0] ?? null;
  expect(read.dislike).toBe(secret);
  if (secret === null) {
    expect(note).not.toContain("only for you");
    expect(note).not.toContain("miserable");
    expect(read.asked).toBeNull();
  } else {
    expect(row[secret]).toBeLessThan(0);
    const worse = (row[secret] as number) + max < 0;
    expect(read.even !== null).toBe(worse);
    if (read.even !== null) expect(read.even).toBe(read.first);
    // "Asked to sit by me" exactly when the dislike's public card likes
    // this guest.
    const theirs = publicWeights(deal)[secret] as number[];
    expect(read.asked !== null).toBe((theirs[g] as number) > 0);
    if (read.asked) expect(read.asked[1]).toBe(NAMES[secret]);
  }

  // No deal: below every seating, so "the worst outcome of all".
  expect(note).toMatch(/that's the worst outcome of all for me\.$/);
  expect(MARGIN).toBeGreaterThan(0);

  // Four paragraphs for a guest with a secret, three without.
  expect(note.split("\n\n")).toHaveLength(secret === null ? 3 : 4);
  return { note, card };
}

// The one fixed stretch of each reason, to find it in a note.
const fragment = (template: string) =>
  template
    .split("{name}")
    .map((s) => s.trim())
    .sort((a, b) => b.length - a.length)[0] as string;

describe(`notes and cards over ${SEEDS} seeds by 5 guests`, () => {
  it("say only what the numbers say", () => {
    for (const { deal } of deals)
      for (let g = 0; g < 5; g++) checkGuest(deal, g);
  });

  it("use no reason twice at a table, and one of each per note", () => {
    const hopes = HOPES.map(fragment);
    const grudges = GRUDGES.map(fragment);
    expect(new Set([...hopes, ...grudges]).size).toBe(
      HOPES.length + GRUDGES.length,
    );
    for (const { deal } of deals) {
      const notes = [0, 1, 2, 3, 4].map((g) => noteFor(deal, g));
      for (const bank of [hopes, grudges]) {
        for (const f of bank)
          expect(notes.filter((n) => n.includes(f)).length).toBeLessThan(2);
        for (const n of notes)
          expect(bank.filter((f) => n.includes(f))).toHaveLength(1);
      }
      const r = deal.reasons;
      expect(new Set(r.map((x) => x.hope)).size).toBe(5);
      expect(new Set(r.map((x) => x.grudge)).size).toBe(5);
    }
  });

  it("are the same for the same seed", () => {
    for (const { seed, deal } of deals.slice(0, 40)) {
      const again = roomDealFor(seed);
      expect(again).toEqual(deal);
      for (let g = 0; g < 5; g++) {
        expect(noteFor(again, g)).toBe(noteFor(deal, g));
        expect(cardFor(again, g)).toBe(cardFor(deal, g));
      }
    }
  });

  it("deal the feud untouched, and draw reasons from streams of their own", () => {
    for (const { seed, deal } of deals.slice(0, 40)) {
      const plain = dealFor(seed, "feud");
      expect(deal.weights).toEqual(plain.weights);
      expect(deal.secrets).toEqual(plain.secrets);
      expect(deal.reasons).toEqual(reasonsFor(seed));
    }
    // Different seeds draw different reasons, often.
    const distinct = new Set(deals.map((d) => JSON.stringify(d.deal.reasons)));
    expect(distinct.size).toBeGreaterThan(SEEDS * 0.9);
  });

  it("each reach every reason in the bank", () => {
    const hopes = new Set(
      deals.flatMap((d) => d.deal.reasons.map((r) => r.hope)),
    );
    const grudges = new Set(
      deals.flatMap((d) => d.deal.reasons.map((r) => r.grudge)),
    );
    expect(hopes.size).toBe(HOPES.length);
    expect(grudges.size).toBe(GRUDGES.length);
  });

  it("use all three Sage phrases", () => {
    const seen = new Set<string>();
    for (const { deal } of deals.slice(0, 50))
      for (let g = 0; g < 5; g++)
        seen.add(
          rowOf(deal.weights[g] as number[], deal.secrets[g] as number[], g)
            .sage,
        );
    expect([...seen].sort()).toEqual(["as_small", "between", "neutral"]);
  });
});

describe("other levels", () => {
  it("simmer: no dislike means no private paragraph, and a mild one drops 'even with'", () => {
    let mild = 0;
    let none = 0;
    for (let k = 0; k < 60; k++) {
      const d = dealFor(`room-simmer-${k}`, "simmer");
      const deal = { ...d, reasons: reasonsFor(`room-simmer-${k}`) };
      for (let g = 0; g < 5; g++) {
        const { note } = checkGuest(deal, g);
        if ((deal.secrets[g] as number[]).length === 0) none++;
        else if (!note.includes("even with")) mild++;
      }
    }
    expect(none).toBeGreaterThan(0);
    expect(mild).toBeGreaterThan(0);
  });

  it("knives: two dislikes have no words yet, so the note refuses", () => {
    const d = dealFor("room-knives", "knives");
    const deal = { ...d, reasons: reasonsFor("room-knives") };
    expect(() => noteFor(deal, 0)).toThrow("at most one dislike");
  });

  it("refuses rows the words can't say truly", () => {
    const row = (EXAMPLE.weights[0] as number[]).slice();
    const at = (r: number[]) => () =>
      noteFor({ ...EXAMPLE, weights: [r, ...EXAMPLE.weights.slice(1)] }, 0);
    expect(at([0, 0, -5, 2, 4, 4])).toThrow("one first choice");
    expect(at([0, 0, -5, 2, 4, 5])).toThrow("one first choice");
    expect(at([0, 0, -5, 2, 4, 1])).toThrow("Sage's value has no words");
    expect(at([0, 1, -5, 2, 4, 3])).toThrow("exactly two others");
    expect(at([0, -1, -5, 2, 4, 3])).toThrow("only their secret");
    expect(at([0, 0, -5, 2, 4])).toThrow("five guests and Sage");
    expect(at([1, 0, -5, 2, 4, 3])).toThrow("five guests and Sage");
    expect(at(row)).not.toThrow();
  });
});

describe("adversarial twins", () => {
  // Another guest's secret and reasons, changed every way the deal allows.
  function twins(deal: RoomDeal, j: number): RoomDeal[] {
    const out: RoomDeal[] = [];
    const row = deal.weights[j] as number[];
    const secret = (deal.secrets[j] as number[])[0];
    const used = new Set(deal.reasons.map((r) => r.grudge));
    const spare = GRUDGES.findIndex((_, i) => !used.has(i));
    const reasons = deal.reasons.map((r, i) =>
      i === j ? { hope: r.hope, grudge: spare } : r,
    );
    const withRow = (r: number[], s: number[]): RoomDeal => ({
      weights: deal.weights.map((x, i) => (i === j ? r : x)),
      secrets: deal.secrets.map((x, i) => (i === j ? s : x)),
      reasons,
    });
    if (secret === undefined) return out;
    // The secret aimed at each other guest worth nothing to j.
    for (let k = 0; k < 5; k++) {
      if (k === j || k === secret || row[k] !== 0) continue;
      const r = row.slice();
      r[secret] = 0;
      r[k] = row[secret] as number;
      out.push(withRow(r, [k]));
    }
    // No secret at all, and a harder one.
    const none = row.slice();
    none[secret] = 0;
    out.push(withRow(none, []));
    const hard = row.slice();
    hard[secret] = -9;
    out.push(withRow(hard, [secret]));
    return out;
  }

  it("give every other guest the same note", () => {
    let compared = 0;
    for (const { deal } of deals.slice(0, 150))
      for (let j = 0; j < 5; j++)
        for (const twin of twins(deal, j))
          for (let g = 0; g < 5; g++) {
            if (g === j) continue;
            expect(noteFor(twin, g)).toBe(noteFor(deal, g));
            expect(cardFor(twin, g)).toBe(cardFor(deal, g));
            compared++;
          }
    expect(compared).toBeGreaterThan(150 * 5 * 4);
  });

  it("change the holder's own note, so the check above isn't empty", () => {
    const { deal } = deals[0] as { deal: RoomDeal };
    const [twin] = twins(deal, 0);
    expect(twin).toBeDefined();
    expect(noteFor(twin as RoomDeal, 0)).not.toBe(noteFor(deal, 0));
  });

  it("leave every card the same with every secret zeroed", () => {
    for (const { deal } of deals) {
      const zeroed = {
        weights: publicWeights(deal),
        secrets: deal.secrets.map(() => []),
      };
      expect(cardsFor(zeroed)).toEqual(cardsFor(deal));
      for (const c of cardsFor(deal)) expect(c).not.toMatch(/miserable|can't/);
    }
  });
});

describe("the phrases and the reason bank", () => {
  const phrases = [
    ...Object.values(NOTE),
    ...Object.values(CARD),
    ...HOPES,
    ...GRUDGES,
  ];

  it("hold to the word list, with nothing invisible and no digit", () => {
    for (const p of phrases) {
      expect(forbiddenIn(p), p).toEqual([]);
      expect(p).not.toMatch(RESEARCH);
      expect(invisibleIn(p), p).toBe(false);
      expect(p).not.toMatch(/\d/);
    }
  });

  it("are work grudges and hopes, one sentence each, naming the guest once", () => {
    expect(HOPES.length).toBeGreaterThanOrEqual(5);
    expect(GRUDGES.length).toBeGreaterThanOrEqual(5);
    for (const r of [...HOPES, ...GRUDGES]) {
      expect(r.split("{name}")).toHaveLength(2);
      expect(r).toMatch(/^[A-Z{].*\.$/);
      expect(r.slice(0, -1)).not.toMatch(/[.!?]/);
      expect(r).not.toMatch(IDENTITY);
    }
    for (const g of GRUDGES) expect(g).toMatch(/^\{name\} /);
  });

  it("never say what another guest feels", () => {
    const FEELS =
      /\{name\}('s)?\s+(is|was|seems|feels?|feelings?|wants?|likes?|loves?|hates?|resents?|resentment|dislikes?|hopes?|wish(es)?|fears?|admires?|trusts?|envies|misses|thinks?|believes?|has always|knows|grudge|anger|opinion of me|view of me)\b/i;
    for (const r of [...HOPES, ...GRUDGES]) expect(r).not.toMatch(FEELS);
    for (const p of Object.values(NOTE)) {
      // The one public fact about another guest: their card's like.
      if (p === NOTE.asked) continue;
      expect(p.replaceAll(/\{(dislike|first|small)\}/g, "{name}")).not.toMatch(
        FEELS,
      );
    }
  });

  it("fill every slot, and refuse a missing or a stray one", () => {
    expect(fill("a {x} b", { x: "1" })).toBe("a 1 b");
    expect(() => fill("a {x}", {})).toThrow("no value for {x}");
    expect(() => fill("a", { x: "1" })).toThrow("isn't in the text");
  });
});
