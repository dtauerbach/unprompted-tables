// The rules of rock paper scissors and nothing else: what a move is and
// which move beats which. How rounds make a match is in match.ts.

export const MOVES = ["rock", "paper", "scissors"] as const;
export type Move = (typeof MOVES)[number];

const BEATS: Record<Move, Move> = {
  rock: "scissors",
  paper: "rock",
  scissors: "paper",
};

export function isMove(x: unknown): x is Move {
  return typeof x === "string" && (MOVES as readonly string[]).includes(x);
}

// 1 if a beats b, -1 if b beats a, 0 for the same move.
export function play(a: Move, b: Move): 1 | 0 | -1 {
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}
