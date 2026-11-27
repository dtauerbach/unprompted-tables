// The scoring contract is versioned separately from the hackathon listing.
export const RUBRIC = {
  version: "m29-v3",
  criteria: {
    works: 30,
    problem: 25,
    originality: 20,
    clarity: 15,
    craft: 10,
  },
  gates: ["readable", "on_time", "in_scope", "present"],
  min: 0,
  max: 5,
} as const;

export const CHECK_RESULTS = [
  "pass",
  "fail",
  "unavailable",
  "unsupported",
  "limit",
  "timeout",
  "error",
] as const;
