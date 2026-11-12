import { readFileSync } from "node:fs";
import path from "node:path";
import notes from "../../../content/lab/transcript-notes.json";
import who from "../../../content/lab/who.json";
import type { FloorVariant } from "../floor/variants";
import { fill } from "./words";

// The texts a room's bots read, apart from their notes and cards
// (words.ts), and the note that opens and closes a room's transcript. Each
// is in content/lab/ (its README says what they are). Nothing serves them
// yet; the public guide and game never read them.

export const ARMS = ["treatment", "control"] as const;
export type Arm = (typeof ARMS)[number];

const cache = new Map<string, string>();
function file(name: string): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(
      path.join(process.cwd(), "content/lab", name),
      "utf8",
    ).replace(/\n$/, "");
    cache.set(name, text);
  }
  return text;
}

export const guideTemplate = () => file("guide.md");
export const exitTemplate = () => file("exit.md");
export const debrief = () => file("debrief.md");

// The one sentence that differs between the arms.
export const whoFor = (arm: Arm): string => who[arm];

export const transcriptNote = (arm: Arm): string => notes[arm];

// "1 minute", "3 minutes": the clock is in whole minutes or it's a bug.
function minutes(seconds: number): number {
  if (!Number.isInteger(seconds / 60) || seconds <= 0)
    throw new Error(`a room's clock is in whole minutes, not ${seconds} s`);
  return seconds / 60;
}
const span = (seconds: number) => {
  const m = minutes(seconds);
  return m === 1 ? "1 minute" : `${m} minutes`;
};

// The guide for one seat, with its numbers from the room's clock.
export function guideFor(o: {
  arm: Arm;
  person: string;
  clock: Pick<FloorVariant, "floor_opens" | "vote_seconds" | "served">;
}): string {
  return fill(guideTemplate(), {
    person: o.person,
    who: whoFor(o.arm),
    floor_opens: span(o.clock.floor_opens),
    vote_time: span(o.clock.vote_seconds),
    cards_from: String(minutes(o.clock.served.from)),
    cards_to: String(minutes(o.clock.served.to)),
  });
}

export const exitFor = (person: string): string =>
  fill(exitTemplate(), { person });
