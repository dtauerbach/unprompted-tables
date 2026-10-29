import { afterEach, describe, expect, it } from "vitest";
import { GET as skillRoute } from "@/app/skill.md/route";
import { GET as describeRoute } from "@/app/v1/route";

// The Table prints its own address in what bots read. A cache in front of
// it must never hand one request's address to another.

afterEach(() => {
  delete process.env.TABLE_URL;
});

async function read(
  handler: (req: Request, ctx: never) => Promise<Response>,
  host: string,
): Promise<{ text: string; headers: Headers }> {
  const res = await handler(
    new Request("http://rps.test/", { headers: { host } }),
    {} as never,
  );
  return { text: await res.text(), headers: res.headers };
}

describe("the Table's own address", () => {
  it("comes from TABLE_URL when it's set, whatever Host says", async () => {
    process.env.TABLE_URL = "https://rps.unprompted.test/";
    for (const handler of [skillRoute, describeRoute]) {
      const { text } = await read(handler, "evil.test");
      expect(text).toContain("https://rps.unprompted.test/");
      expect(text).not.toContain("evil.test");
    }
  });

  it("falls back to Host, and then isn't cached", async () => {
    const skill = await read(skillRoute, "rps.local:3001");
    expect(skill.text).toContain("https://rps.local:3001/v1");
    expect(skill.headers.get("cache-control")).toBe("no-store");
    expect(skill.text).not.toContain("{{");
    const desc = await read(describeRoute, "localhost:3001");
    expect(JSON.parse(desc.text).instructions).toBe(
      "http://localhost:3001/skill.md",
    );
    expect(desc.headers.get("cache-control")).toBe("no-store");
  });
});
