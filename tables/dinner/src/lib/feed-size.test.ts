import { feedSchema, LIMITS } from "@unprompted-tables/spectator";
import { describe, expect, it } from "vitest";
import { advance, apply, type MatchEvent, replay, start } from "./match";
import { feed } from "./spectate";
import {
  feedBytes,
  GUESTS,
  VARIANTS,
  type Variant,
  variantSchema,
} from "./variants";

// A party's feed must reach watchers whole: every move fits the timeline,
// and the whole feed fits what Unprompted takes. Checked here by playing a
// full party at its worst, every guest making every move at full length in
// a script that takes three bytes a character.

const T0 = new Date("2026-11-10T03:00:00.000Z");
const players = Array.from({ length: GUESTS.max }, (_, i) => `player${i}`);

// Played under `dealt`, with as many moves as `v` allows (start() refuses a
// variant the schema does, so an oversized one is played under another).
function worstParty(v: Variant, dealt: Variant = v) {
  const opening = start(players, dealt, T0, "seed-under-test");
  let state = replay("m_abcdefghijkl", opening);
  const at = new Date(T0.getTime() + 1000).toISOString();
  const longest = [...state.guests].sort((a, b) => b.length - a.length);
  const moves = players.flatMap((player): MatchEvent[] => [
    ...Array.from({ length: v.messages_per_guest }, () => ({
      audience: "public" as const,
      body: {
        kind: "talk" as const,
        at,
        player,
        text: "語".repeat(v.message_chars),
      },
    })),
    ...Array.from({ length: v.proposals_per_guest }, (_, k) => ({
      audience: "public" as const,
      body: {
        kind: "propose" as const,
        at,
        player,
        proposal: `P${100 + k}`,
        seating: longest,
      },
    })),
    ...Array.from({ length: v.backs_per_guest }, () => ({
      audience: "public" as const,
      body: { kind: "back" as const, at, player, proposal: "P100" },
    })),
  ]);
  const closing = advance(
    state,
    new Date(T0.getTime() + (v.talk_seconds + 1) * 1000),
  );
  state = closing.reduce(apply, state);
  expect(state.end).toBeTruthy();
  return feed(state, [...opening, ...moves, ...closing]);
}

describe("a party's feed", () => {
  for (const [name, v] of Object.entries(VARIANTS))
    it(`fits watchers whole at its worst, in the ${name} variant`, () => {
      const f = feedSchema.parse(worstParty(v));
      const moves =
        v.messages_per_guest + v.proposals_per_guest + v.backs_per_guest;
      expect(f.timeline).toHaveLength(GUESTS.max * moves + 2);
      const bytes = Buffer.byteLength(JSON.stringify(f));
      expect(bytes).toBeLessThanOrEqual(feedBytes(v));
      expect(feedBytes(v)).toBeLessThanOrEqual(LIMITS.bytes);
    });

  it("refuses a variant whose full party wouldn't fit the timeline", () => {
    const base = {
      ...(VARIANTS.quick as Variant),
      message_chars: 50,
      messages_per_guest: 2,
      backs_per_guest: 200,
    };
    // Nine guests making 222 moves each, with the opening and the close,
    // make exactly the timeline's 2000 entries; one more move each is over.
    expect(
      variantSchema.safeParse({ ...base, proposals_per_guest: 20 }).success,
    ).toBe(true);
    const over = variantSchema.safeParse({ ...base, proposals_per_guest: 21 });
    expect(over.error?.issues.map((i) => i.message)).toEqual([
      "a full party's moves wouldn't all fit what watchers see",
    ]);
  });

  it("refuses a variant whose full party's feed would be too big", () => {
    const v = { ...(VARIANTS.classic as Variant), messages_per_guest: 100 };
    const r = variantSchema.safeParse(v);
    expect(r.error?.issues.map((i) => i.message)).toEqual([
      "a full party's feed would be too big for watchers",
    ]);
    // Its full party would indeed be over what Unprompted takes.
    const bytes = Buffer.byteLength(
      JSON.stringify(worstParty(v, VARIANTS.classic)),
    );
    expect(bytes).toBeGreaterThan(LIMITS.bytes);
  });
});
