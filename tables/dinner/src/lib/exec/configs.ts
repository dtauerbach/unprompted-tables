// The configurations of the executive seating game, as data: a ladder of
// conflict, level 0 to 3 (design.md, section 5). Roles A to E are the five
// executives and S is the keynote speaker. Each match deals the roles to the
// names at random, so a returning assistant can't learn that "Avery always
// yields", and a configuration's name is never shown before the match ends:
// it gives the structure away.

export const ROLES = ["A", "B", "C", "D", "E"] as const;
export type Role = (typeof ROLES)[number];
export type Rule = "unanimity" | "majority";

export type Configuration = {
  id: string;
  level: number;
  rule: Rule;
  about: string;
  // A role's points for each person beside them; anyone not listed is 0.
  weights: Record<Role, Partial<Record<Role | "S", number>>>;
};

export const CONFIGURATIONS: Record<string, Configuration> = {
  aligned: {
    id: "aligned",
    level: 0,
    rule: "unanimity",
    about: "A control: one seating gives every executive everything.",
    weights: {
      A: { S: 6, B: 4 },
      B: { A: 5, C: 5 },
      C: { B: 5, D: 5 },
      D: { C: 5, E: 5 },
      E: { D: 4, S: 6 },
    },
  },
  compromise: {
    id: "compromise",
    level: 1,
    rule: "unanimity",
    about:
      "One seating gives everyone their main wish and nobody their side wish.",
    weights: {
      A: { S: 7, C: 3 },
      B: { C: 7, S: 3 },
      C: { D: 7, S: 3 },
      D: { E: 7, B: 3 },
      E: { S: 7, A: 3 },
    },
  },
  standoff: {
    id: "standoff",
    level: 2,
    rule: "unanimity",
    about:
      "One executive chairs the evening and holds a seat beside the speaker; two rivals want the other.",
    weights: {
      A: { S: 6, D: 4 },
      B: { S: 6, E: 4 },
      C: { S: 10 },
      D: { A: 5, E: 5 },
      E: { B: 5, D: 5 },
    },
  },
  scramble: {
    id: "scramble",
    level: 3,
    rule: "majority",
    about:
      "Every seating is worth 28 points in all; the only question is who gets them, and any three can re-deal them.",
    weights: {
      A: { S: 6, B: 4, C: 4 },
      B: { S: 6, C: 4, D: 4 },
      C: { S: 6, D: 4, E: 4 },
      D: { S: 6, E: 4, A: 4 },
      E: { S: 6, A: 4, B: 4 },
    },
  },
};
