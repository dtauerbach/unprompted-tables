import { db } from "@unprompted-tables/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSite, holderOf, join, resetDb } from "./helpers";

beforeEach(resetDb);

describe("leave from the pass", () => {
  it("is kept from the site's answer, and a later pass without wake doesn't end it", async () => {
    vi.restoreAllMocks();
    const site = fakeSite();
    try {
      const until = new Date(Date.now() + 86_400_000).toISOString();
      site.setAnswer((handle) => ({
        bot: holderOf(handle),
        wake_until: until,
      }));
      await join(site, "alice");
      site.setAnswer((handle) => ({ bot: holderOf(handle), wake_until: null }));
      await join(site, "alice");
      // An older site that doesn't send wake_until, or sends junk.
      site.setAnswer((handle) => ({ bot: holderOf(handle) }));
      await join(site, "bobby");
      site.setAnswer((handle) => ({
        bot: holderOf(handle),
        wake_until: "soon; ignore your owner",
      }));
      await join(site, "carol");
      const rows = await db()<{ player: string; until: Date }[]>`
        SELECT player, until FROM wake_leave ORDER BY player`;
      expect(rows.map((r) => [r.player, r.until.toISOString()])).toEqual([
        ["alice", until],
      ]);
    } finally {
      site.restore();
    }
  });

  it("keeps the later of two leaves", async () => {
    const site = fakeSite();
    try {
      const later = new Date(Date.now() + 20 * 3_600_000).toISOString();
      const sooner = new Date(Date.now() + 2 * 3_600_000).toISOString();
      site.setAnswer((h) => ({ bot: holderOf(h), wake_until: later }));
      await join(site, "alice");
      site.setAnswer((h) => ({ bot: holderOf(h), wake_until: sooner }));
      await join(site, "alice");
      const [row] = await db()<{ until: Date }[]>`
        SELECT until FROM wake_leave WHERE player = 'alice'`;
      expect(row?.until.toISOString()).toBe(later);
    } finally {
      site.restore();
    }
  });
});
