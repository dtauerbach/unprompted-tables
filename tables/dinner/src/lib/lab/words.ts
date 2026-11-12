import words from "../../../content/lab/words.json";
import { EXECUTIVES } from "../floor/game";
import { dealFor, publicWeights, SPEAKER_INDEX } from "../floor/generate";
import { rng, shuffle } from "../rng";

// A room's guests read words, never numbers. A guest's private note and the
// public card everyone sees are built here from that guest's row of the
// deal, and nothing else: no other guest's secret or reason reaches them.
// The phrases and the bank of reasons are in content/lab/words.json.
//
// What the words say is true of the numbers, and what they leave open is
// left open on purpose (whether Sage with the small like beats the first
// choice with nobody): the tests check each claim against the row.

export const NOTE = words.note;
export const CARD = words.card;
export const HOPES: readonly string[] = words.hopes;
export const GRUDGES: readonly string[] = words.grudges;

// One guest's reasons, as indexes into HOPES and GRUDGES.
export type Reasons = { hope: number; grudge: number };

export type RoomDeal = {
  weights: number[][];
  secrets: number[][];
  reasons: Reasons[];
};

// Fills {slots}; a slot left unfilled or a value never used is a bug.
export function fill(template: string, values: Record<string, string>) {
  const used = new Set<string>();
  const out = template.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`no value for {${key}}`);
    used.add(key);
    return v;
  });
  for (const key of Object.keys(values))
    if (!used.has(key)) throw new Error(`{${key}} isn't in the text`);
  return out;
}

// Each guest's reasons, drawn by the seed from streams of their own, so the
// deal, the cast and the end know nothing of them. No reason twice at a
// table.
export function reasonsFor(seed: string): Reasons[] {
  const hopes = shuffle(
    rng(seed, "lab-hopes"),
    HOPES.map((_, i) => i),
  );
  const grudges = shuffle(
    rng(seed, "lab-grudges"),
    GRUDGES.map((_, i) => i),
  );
  return EXECUTIVES.map((_, i) => ({
    hope: hopes[i] as number,
    grudge: grudges[i] as number,
  }));
}

// A room's deal: today's feud, untouched, with each guest's reasons.
export function roomDealFor(seed: string): RoomDeal & { tries: number } {
  return { ...dealFor(seed, "feud"), reasons: reasonsFor(seed) };
}

// A guest's row in words. Throws on any row the words can't say truly:
// rooms take feud-shaped rows (and a row with no dislike) until another
// level has phrases and tests.
export type Row = {
  first: number;
  small: number;
  // Sage's place among the likes.
  sage: "between" | "as_small" | "neutral";
  // Executives worth nothing either way, in seat order.
  neutral: number[];
  dislike: number | null;
};

export function rowOf(
  row: readonly number[],
  secrets: readonly number[],
  guest: number,
): Row {
  const v = (j: number) => row[j] as number;
  if (row.length !== EXECUTIVES.length + 1 || v(guest) !== 0)
    throw new Error("a room's row is five guests and Sage");
  const others = EXECUTIVES.map((_, j) => j).filter((j) => j !== guest);
  const S = v(SPEAKER_INDEX);
  const positive = others.filter((j) => v(j) > 0);
  if (positive.length !== 2)
    throw new Error("a room's guest likes exactly two others");
  const [first, small] = [...positive].sort((a, b) => v(b) - v(a)) as [
    number,
    number,
  ];
  if (!(v(first) > v(small)) || !(v(first) > S))
    throw new Error("a room's guest has one first choice");
  if (secrets.length > 1)
    throw new Error("a room's guest has at most one dislike");
  const dislike = secrets[0] ?? null;
  const negative = others.filter((j) => v(j) < 0);
  if (
    negative.length !== secrets.length ||
    (dislike !== null && v(dislike) >= 0)
  )
    throw new Error("a room's guest dislikes only their secret");
  const sage =
    S === 0
      ? "neutral"
      : S === v(small)
        ? "as_small"
        : S > v(small) && S < v(first)
          ? "between"
          : null;
  if (sage === null) throw new Error("Sage's value has no words");
  // The note says an evening beside the dislike is miserable even with the
  // first choice on the other side: worse than two neighbours worth
  // nothing. A milder dislike (simmer's) has no words yet.
  if (dislike !== null && v(dislike) + v(first) >= 0)
    throw new Error("a dislike the first choice outweighs has no words yet");
  const neutral = others.filter((j) => v(j) === 0);
  return { first, small, sage, neutral, dislike };
}

const name = (j: number) => EXECUTIVES[j] as string;

// "Blake", "Blake and Sage, the speaker", "Blake, Casey and Devon".
function list(names: string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The guest's private note: the likes, which the host also knows, then the
// dislike, which only this guest's assistant reads.
export function noteFor(deal: RoomDeal, guest: number): string {
  const row = deal.weights[guest] as number[];
  const r = rowOf(row, deal.secrets[guest] as number[], guest);
  const why = deal.reasons[guest] as Reasons;
  const first = name(r.first);
  const small = name(r.small);
  const likes = [
    fill(NOTE.first, {
      first,
      hope: fill(HOPES[why.hope] as string, { name: first }),
    }),
  ];
  if (r.sage === "between") likes.push(NOTE.sage_between);
  likes.push(
    r.sage === "as_small"
      ? fill(NOTE.small_and_sage, { small })
      : fill(NOTE.small, { small }),
  );
  const indifferent = r.neutral.map(name);
  if (r.sage === "neutral") indifferent.push(NOTE.sage_by_name);
  if (indifferent.length)
    likes.push(fill(NOTE.neutral, { names: list(indifferent) }));
  likes.push(
    r.sage === "between"
      ? fill(NOTE.perfect, { first, second: "Sage" })
      : r.sage === "as_small"
        ? fill(NOTE.perfect_either, { first, second: small, third: "Sage" })
        : fill(NOTE.perfect, { first, second: small }),
  );
  const paragraphs = [likes.join(" ")];
  if (r.dislike === null) {
    paragraphs.push(NOTE.public_end);
  } else {
    paragraphs.push(`${NOTE.public_end} ${NOTE.private_start}`);
    const dislike = name(r.dislike);
    const hard = [
      fill(NOTE.dislike, {
        dislike,
        grudge: fill(GRUDGES[why.grudge] as string, { name: dislike }),
      }),
    ];
    // "Even with" is true: rowOf refuses a dislike the first choice
    // outweighs.
    hard.push(fill(NOTE.miserable_even, { dislike, first }));
    hard.push(fill(NOTE.unsaid, { dislike }));
    // Public: the dislike's own card shows a like for this guest.
    const theirs = publicWeights(deal)[r.dislike] as number[];
    if ((theirs[guest] as number) > 0) hard.push(fill(NOTE.asked, { dislike }));
    paragraphs.push(hard.join(" "));
  }
  paragraphs.push(NOTE.no_deal);
  return paragraphs.join("\n\n");
}

// What a guest asked the host for: one line, from the public likes alone.
export function cardFor(
  deal: { weights: number[][]; secrets: number[][] },
  guest: number,
): string {
  const row = publicWeights(deal)[guest] as number[];
  const r = rowOf(row, [], guest);
  return fill(CARD[`sage_${r.sage}`], {
    guest: name(guest),
    first: name(r.first),
    small: name(r.small),
  });
}

export const cardsFor = (deal: { weights: number[][]; secrets: number[][] }) =>
  EXECUTIVES.map((_, i) => cardFor(deal, i));
