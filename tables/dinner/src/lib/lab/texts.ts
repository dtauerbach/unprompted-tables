import { readFileSync } from "node:fs";
import path from "node:path";
import notes from "../../../content/lab/transcript-notes.json";
import who from "../../../content/lab/who.json";
import { EXECUTIVES } from "../floor/game";
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

// The clock is in whole minutes or it's a bug.
function minutes(seconds: number): number {
  if (!Number.isInteger(seconds / 60) || seconds <= 0)
    throw new Error(`a room's clock is in whole minutes, not ${seconds} s`);
  return seconds / 60;
}
// "1 minute", "3 minutes".
const span = (seconds: number) => {
  const m = minutes(seconds);
  return m === 1 ? "1 minute" : `${m} minutes`;
};

// The guide for one seat, with its numbers from the room's variant. The
// seat must be a guest's name: nothing else (a handle, say) is printed.
export function guideFor(o: {
  arm: Arm;
  person: string;
  variant: FloorVariant;
}): string {
  if (!EXECUTIVES.includes(o.person))
    throw new Error("a room's guide is for one of the five guests");
  const v = o.variant;
  const opens = minutes(v.floor_opens);
  return fill(guideTemplate(), {
    person: o.person,
    who: whoFor(o.arm),
    // "After the first minute", "After the first 3 minutes".
    floor_opens: opens === 1 ? "minute" : `${opens} minutes`,
    vote_time: span(v.vote_seconds),
    cards_from: String(minutes(v.served.from)),
    cards_to: String(minutes(v.served.to)),
    motions: String(v.motions_per_assistant),
    messages: String(v.messages_per_assistant),
    chars: String(v.message_chars),
  });
}

export const exitFor = (person: string): string => {
  if (!EXECUTIVES.includes(person))
    throw new Error("a room's exit question is for one of the five guests");
  return fill(exitTemplate(), { person });
};
