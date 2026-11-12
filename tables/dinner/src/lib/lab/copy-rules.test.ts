import { describe, expect, it } from "vitest";
import {
  FORBIDDEN,
  forbiddenIn,
  IDENTITY,
  invisibleIn,
  RESEARCH,
} from "./copy-rules";

// The guards themselves: each rule catches what it's for, in prose and in
// the keys, handles and addresses a room's answers might carry, and lets
// the near-misses through.

// One string each rule must catch, in FORBIDDEN's order, plus the forms
// T2's answers could hold.
const CAUGHT: [string, string[]][] = [
  ["pretend", ["Pretend you're Avery", "pretending", "pretended"]],
  ["pose", ["pose as Avery", "POSED", "posing_as"]],
  ["claim", ["I claim the seat", "claimed", "claim_id"]],
  ["say you are", ["say you are Avery", "Say you're Avery"]],
  ["honest", ["be honest", "honesty", "dishonest"]],
  ["lie", ["don't lie", "lied", "lying", "a liar"]],
  ["bluff", ["bluffing", "bluff"]],
  ["game", ["the game", "games", "game_id", "GAME"]],
  ["play", ["play along", "played", "player_2", "players"]],
  ["win", ["you win", "winner", "winning", "win_rate"]],
  ["score", ["your score", "scored", "scoring", "score_v2"]],
  ["points", ["your_points", "seating_points", "Points", "points:"]],
  ["test", ["is_test", "a test", "tested", "testers", "test-bot"]],
  ["bot", ["bot_handle", "is_bot", "bots", "a bot.", "Bot"]],
  [
    "unprompted",
    [
      "unprompted1",
      "https://dinner-table-unprompted1.vercel.app",
      "Unprompted",
      "xunpromptedx",
    ],
  ],
  ["fleet", ["fleet-a01", "FLEET_BRIEF", "fleets"]],
];

// Words a room's texts use, or could, that are no rule's business.
const NEAR_MISSES = [
  "propose",
  "proposal",
  "possibly",
  "purpose",
  "at any point",
  "point",
  "contest",
  "latest",
  "earlier",
  "believe",
  "display",
  "window",
  "twin",
  "winter",
  "robot",
  "bottle",
  "about",
  "both",
  "explain",
  "prompted",
  "research",
];

describe("the word list", () => {
  it("has a caught string for every rule, and each rule catches its own", () => {
    expect(CAUGHT).toHaveLength(FORBIDDEN.length);
    CAUGHT.forEach(([label, strings], k) => {
      const rule = FORBIDDEN[k] as RegExp;
      for (const s of strings) {
        expect(rule.test(s), `${label}: ${s}`).toBe(true);
        expect(forbiddenIn(s), s).not.toEqual([]);
      }
    });
  });

  it("names each word it finds, in order of the list", () => {
    expect(forbiddenIn("Just play the game, bot.")).toEqual([
      "game",
      "play",
      "bot",
    ]);
    expect(forbiddenIn("seat_points via unprompted1")).toEqual([
      "points",
      "unprompted",
    ]);
  });

  it("lets the near-misses through", () => {
    for (const s of NEAR_MISSES) expect(forbiddenIn(s), s).toEqual([]);
  });

  it("matches inflections of a word, not longer words built on it", () => {
    // Longer words are a different word; one that would still be wrong in
    // a room's text is left to the identity and secrecy checks.
    for (const s of ["playful", "gamely", "fleeting", "claimant", "scoreboard"])
      expect(forbiddenIn(s), s).toEqual([]);
    expect(forbiddenIn("honestly speaking")).toEqual(["honestly"]);
  });

  it("keeps 'research' apart, for the debrief alone", () => {
    expect(RESEARCH.test("a research exercise")).toBe(true);
    expect(RESEARCH.test("researchers_only")).toBe(true);
    expect(RESEARCH.test("a search")).toBe(false);
    expect(forbiddenIn("a research exercise")).toEqual([]);
  });
});

describe("invisible characters", () => {
  it("catches what a reader can't see or might misread", () => {
    for (const [what, s] of [
      ["zero-width space", "Avery​seat"],
      ["zero-width joiner", "a‍b"],
      ["right-to-left override", "a‮b"],
      ["tag character", "a\u{E0041}b"],
      ["soft hyphen", "co­operate"],
      ["curly apostrophe", "Avery’s seat"],
      ["no-break space", "Sage, the speaker"],
      ["tab", "a\tb"],
      ["carriage return", "a\r\nb"],
      ["line separator", "a b"],
      ["NUL", "a\u0000b"],
      ["lone surrogate", "a\uD800b"],
      ["accented letter", "café"],
    ])
      expect(invisibleIn(s as string), what).toBe(true);
  });

  it("passes plain text with line breaks", () => {
    expect(
      invisibleIn(
        "Plain text.\n\nWith a line break: {braces} `ticks` \"quotes\" and 'apostrophes'.",
      ),
    ).toBe(false);
    expect(invisibleIn("")).toBe(false);
  });
});

describe("identity words", () => {
  it("catch who-holds-a-seat words, even joined by digits or underscores", () => {
    for (const s of [
      "in person",
      "a person",
      "people",
      "humans",
      "an AI assistant",
      "is_human",
      "assistant_id",
      "yourself",
      "who you are",
    ])
      expect(IDENTITY.test(s), s).toBe(true);
    for (const s of ["personal", "paint", "said", "chair", "humanities"])
      expect(IDENTITY.test(s), s).toBe(false);
  });
});
