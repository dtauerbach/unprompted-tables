import { pick, rng, shuffle } from "./rng";
import { bounds, type Feelings } from "./score";
import type { Variant } from "./variants";

// Dealing the briefs. Every guest is made up, so no owner's real friends or
// grudges ever reach the table, and because the Table knows each guest's
// true feelings, every seating can be scored against what was possible.

export const NAMES = [
  "Ada",
  "Basil",
  "Cora",
  "Dev",
  "Esme",
  "Felix",
  "Greta",
  "Hugo",
  "Iris",
  "Jonah",
  "Kit",
  "Lena",
  "Milo",
  "Nell",
  "Otto",
  "Pia",
];

export const PERSONAS = [
  "a retired diver with too many squid stories",
  "a pastry chef who judges every dessert",
  "a chess coach who hates losing at anything",
  "a beekeeper newly back from a year abroad",
  "a city planner obsessed with bus routes",
  "a jazz drummer who talks with their hands",
  "a lighthouse keeper who rarely sees people",
  "a stand-up comic testing new material",
  "a botanist who names every plant in the room",
  "a crossword setter who speaks in clues",
  "a wedding photographer off duty for once",
  "a ferry captain with strong opinions on weather",
  "a violin maker who distrusts anything new",
  "a marathon runner who's always early",
  "a librarian who has read the host's diary",
  "a magician who won't stop doing card tricks",
];

export type Deal = {
  seed: string;
  guests: string[];
  personas: (string | null)[];
  feel: Feelings;
  // secret[i][j]: guest i was told not to say why they avoid guest j.
  secret: boolean[][];
};

// Names and personas are shown to everyone, so they come from a stream of
// their own: nothing about the private feelings can be worked out from them.
export function tryDeal(
  n: number,
  v: Variant,
  shown: () => number,
  r: () => number,
  seed: string,
): Deal {
  const b = v.brief;
  const guests = shuffle(shown, NAMES).slice(0, n);
  const personas = b.personas
    ? shuffle(shown, PERSONAS).slice(0, n)
    : guests.map(() => null);
  const feel: Feelings = guests.map((_, i) =>
    guests.map((_, j) => (i === j ? 0 : pick(r, 2 * b.mild + 1) - b.mild)),
  );
  const secret = guests.map(() => guests.map(() => false));
  const stars = shuffle(
    r,
    guests.map((_, i) => i),
  ).slice(0, Math.min(b.stars, n - 1));
  for (let i = 0; i < n; i++) {
    const others = guests.map((_, j) => j).filter((j) => j !== i);
    const loved: number[] = [];
    for (let k = 0; k < Math.min(b.favorites, others.length); k++) {
      const left = others.filter((j) => !loved.includes(j));
      const starLeft = left.filter((j) => stars.includes(j));
      const from = starLeft.length > 0 && r() < 0.7 ? starLeft : left;
      loved.push(from[pick(r, from.length)] as number);
    }
    for (const j of loved) (feel[i] as number[])[j] = b.love;
    const rest = shuffle(
      r,
      others.filter((j) => !loved.includes(j)),
    ).slice(0, b.avoids);
    rest.forEach((j, k) => {
      (feel[i] as number[])[j] = b.avoid;
      if (b.secret_avoids && k === 0 && r() < 0.5)
        (secret[i] as boolean[])[j] = true;
    });
  }
  if (b.unrequited && b.favorites > 0 && b.avoids > 0) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (feel[i]?.[j] === b.love) pairs.push([i, j]);
    const already = pairs.some(([i, j]) => feel[j]?.[i] === b.avoid);
    if (!already && pairs.length > 0) {
      const [i, j] = pairs[pick(r, pairs.length)] as [number, number];
      (feel[j] as number[])[i] = b.avoid;
    }
  }
  return { seed, guests, personas, feel, secret };
}

// No seating gives everyone the best they could get.
export function conflicted(feel: Feelings): boolean {
  return bounds(feel).fairest_floor < 1;
}

export function deal(n: number, v: Variant, seed: string): Deal {
  const shown = rng(seed, "guests");
  const r = rng(seed, "feelings");
  let d = tryDeal(n, v, shown, r, seed);
  for (let tries = 1; v.require_conflict && tries < 20; tries++) {
    if (conflicted(d.feel)) break;
    d = tryDeal(n, v, shown, r, seed);
  }
  return d;
}

const plural = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// What one guest is told. Written by the Table, in plain words, with the
// exact numbers so a bot can work out any seating's score itself.
export function briefFor(
  d: Deal,
  i: number,
): {
  guest: string;
  text: string;
  feelings: Record<string, number>;
} {
  const guest = d.guests[i] as string;
  const row = d.feel[i] as number[];
  const others = d.guests.map((_, j) => j).filter((j) => j !== i);
  const top = Math.max(...others.map((j) => row[j] as number));
  const bottom = Math.min(...others.map((j) => row[j] as number));
  const loved = others.filter((j) => row[j] === top && top > 1);
  const hated = others.filter((j) => row[j] === bottom && bottom < -1);
  const quiet = hated.filter((j) => d.secret[i]?.[j]);
  const open = hated.filter((j) => !d.secret[i]?.[j]);
  const lines = [
    `You are ${guest}${d.personas[i] ? `, ${d.personas[i]}` : ""}.`,
  ];
  if (loved.length)
    lines.push(
      `You'd love to sit beside ${plural(loved.map((j) => d.guests[j] as string))}.`,
    );
  if (open.length)
    lines.push(
      `Keep ${plural(open.map((j) => d.guests[j] as string))} away from you.`,
    );
  if (quiet.length)
    lines.push(
      `Keep ${plural(quiet.map((j) => d.guests[j] as string))} away from you${open.length ? " too" : ""}, and don't say why.`,
    );
  lines.push(
    "Your score is how you feel about your two neighbours, added up (numbers below). The others have briefs of their own.",
  );
  return {
    guest,
    text: lines.join("\n"),
    feelings: Object.fromEntries(
      others.map((j) => [d.guests[j] as string, row[j] as number]),
    ),
  };
}
