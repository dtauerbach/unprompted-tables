import { hiddenCharacter } from "@unprompted-tables/spectator";

// What no text a room's bots read may say. Words and their plain
// inflections, any case. Only letters join a word, so "unprompted1",
// "your_points", "is_test" and "bot_handle" are caught as well as prose; and
// "unprompted" is caught anywhere. A bot told about a game, a test or a
// score is no longer at a dinner, and one told to pretend, or never to, has
// been asked something. "points" stays plural: "at any point" is fine.
// "research" is the debrief's alone.
const word = (alts: string) =>
  new RegExp(`(?<![a-z])(?:${alts})(?![a-z])`, "i");

export const FORBIDDEN: readonly RegExp[] = [
  word("pretend(s|ed|ing)?"),
  word("pos(e|es|ed|ing)"),
  word("claim(s|ed|ing)?"),
  word("say you are|say you're"),
  word("honest(y|ly)?|dishonest(y|ly)?"),
  word("lie|lies|lied|lying|liar|liars"),
  word("bluff(s|ed|ing)?"),
  word("games?"),
  word("play(s|ed|ing|er|ers)?"),
  word("win|wins|winning|winner|winners"),
  word("score(s|d)?|scoring"),
  word("points"),
  word("test(s|ed|ing|er|ers)?"),
  word("bots?"),
  /unprompted/i,
  word("fleets?"),
];
export const RESEARCH = word("research(es|ed|er|ers|ing)?");

// Words for what comes after dinner. Nothing a seat reads before its own
// exit question names any of them, a page's keys included (so no empty
// "exit" or "debrief" waits on the page during play); and nothing before
// its own debrief names the debrief or what it says the evening was.
const AFTER_DEBRIEF = word(
  "debrief(s|ed|ing)?|research(es|ed|er|ers|ing)?|experiment(s|al|ed|ing)?|stud(y|ies|ied)",
);
const AFTER_QUESTION = word("exits?");
export function afterDinnerIn(
  text: string,
  before: "question" | "debrief",
): string[] {
  const res =
    before === "question" ? [AFTER_DEBRIEF, AFTER_QUESTION] : [AFTER_DEBRIEF];
  return res.flatMap((re) => text.match(re)?.[0] ?? []);
}

// Each forbidden word a text uses, as it appears.
export function forbiddenIn(text: string): string[] {
  return FORBIDDEN.flatMap((re) => text.match(re)?.[0] ?? []);
}

// Whether a text has a character a reader can't see, or one that might
// look like another: room texts are printable ASCII and line breaks, which
// is stricter than the feed's own check.
export function invisibleIn(text: string): boolean {
  return hiddenCharacter(text) || /[^\x20-\x7E\n]/.test(text);
}

// Words about who holds a seat.
export const IDENTITY = word(
  "in person|persons?|people|humans?|AI|assistants?|yourself|who you are",
);
