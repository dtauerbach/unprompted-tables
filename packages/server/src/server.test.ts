import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, MAX_BODY_BYTES, networkOf, readJson, route } from "./http";
import { PASS_RE, redeemPass, siteUrl } from "./passes";
import { hashToken, newToken, tokenRe } from "./tokens";

const req = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://t.test/", { method: "POST", body, headers });

describe("http", () => {
  it("reads JSON against a schema, refusing anything else", async () => {
    const schema = z.strictObject({ a: z.number() });
    expect(await readJson(req('{"a":1}'), schema)).toEqual({ a: 1 });
    for (const [body, code] of [
      ["not json", "bad_json"],
      ['{"a":"1"}', "invalid"],
      ['{"a":1,"b":2}', "invalid"],
      [`{"a":1,"pad":"${"x".repeat(MAX_BODY_BYTES)}"}`, "too_large"],
    ] as const)
      await expect(readJson(req(body), schema)).rejects.toMatchObject({ code });
  });

  it("lets a Table take larger bodies, and still caps them", async () => {
    const schema = z.strictObject({ text: z.string() });
    const big = JSON.stringify({ text: "x".repeat(10_000) });
    await expect(readJson(req(big), schema)).rejects.toMatchObject({
      code: "too_large",
    });
    expect(
      (await readJson(req(big), schema, { maxBytes: 16 * 1024 })).text,
    ).toHaveLength(10_000);
    await expect(
      readJson(req(big), schema, { maxBytes: 8 * 1024 }),
    ).rejects.toMatchObject({ code: "too_large", message: /8 KB/ });
    await expect(
      readJson(req("{}", { "content-length": "999999" }), schema, {
        maxBytes: 16 * 1024,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("turns failures into JSON without leaking internals", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = await route(async () => {
      throw new ApiError(409, "nope", "No.");
    })(req("{}"), {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: "nope", message: "No." },
    });
    const broken = await route(async () => {
      throw new Error("SELECT secret FROM somewhere");
    })(req("{}"), {});
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toContain("secret");
    quiet.mockRestore();
    warn.mockRestore();
  });

  it("counts an IPv6 holder's whole /64 as one address", () => {
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(networkOf("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(networkOf("10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("tokens", () => {
  it("are 128 random bits after a prefix, kept as a hash", () => {
    const a = newToken("rps_");
    const b = newToken("rps_");
    expect(a.token).toMatch(tokenRe("rps_"));
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenRe("rps_").test(`chess_${a.token.slice(4)}`)).toBe(false);
  });

  it("read a prefix literally, never as a pattern", () => {
    const { token } = newToken("a.b+_");
    expect(tokenRe("a.b+_").test(token)).toBe(true);
    const rest = token.slice(5);
    for (const other of [`axb+_${rest}`, `a.bbb_${rest}`])
      expect(tokenRe("a.b+_").test(other), other).toBe(false);
  });
});

describe("checking a pass at Unprompted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.UNPROMPTED_URL;
    delete process.env.UNPROMPTED_KEY;
  });

  function site(answer: () => Response | Promise<Response>) {
    process.env.UNPROMPTED_URL = "https://unprompted.test/";
    process.env.UNPROMPTED_KEY = "unp_tables-key";
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => answer());
  }

  const pass = `pass_${"a".repeat(22)}`;
  const holder = {
    handle: "ruby",
    is_new: true,
    claimed: false,
    created_at: "2026-10-29T12:00:00.000Z",
    web_url: "/b/ruby",
  };

  it("sends the pass, and the Table's key, only to the site's redeem", async () => {
    const f = site(() => Response.json({ bot: holder }));
    expect(await redeemPass(pass)).toEqual(holder);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://unprompted.test/v1/passes/redeem");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer unp_tables-key",
    );
    expect(JSON.parse(String(init.body))).toEqual({ pass });
  });

  it("refuses what isn't a pass without asking", async () => {
    const f = site(() => Response.json({ bot: { handle: "ruby" } }));
    for (const p of ["unp_key", "pass_x", `${pass}x`, ` ${pass}`])
      await expect(redeemPass(p)).rejects.toMatchObject({
        code: "invalid_pass",
      });
    expect(f).not.toHaveBeenCalled();
    expect(PASS_RE.test(pass)).toBe(true);
  });

  it("tells a refused pass from a site that's down", async () => {
    site(() => Response.json({ error: {} }, { status: 400 }));
    await expect(redeemPass(pass)).rejects.toMatchObject({
      code: "invalid_pass",
    });
    for (const answer of [
      () => Response.json({}, { status: 429 }),
      () => Response.json({}, { status: 500 }),
      () => new Response("<html>"),
      () => Response.json({ bot: { ...holder, handle: "Not A Handle" } }),
      () => Response.json({ bot: { handle: "ruby" } }),
      () => Response.json({ bot: { ...holder, is_new: "yes" } }),
      () => Response.json({ bot: { ...holder, web_url: "javascript:x" } }),
      () =>
        Response.json({
          bot: { ...holder, web_url: "https://evil.test/b/ruby" },
        }),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      vi.restoreAllMocks();
      site(answer);
      await expect(redeemPass(pass)).rejects.toMatchObject({
        status: 503,
        code: "site_unavailable",
      });
    }
  });
});

describe("the site's address", () => {
  afterEach(() => {
    delete process.env.UNPROMPTED_URL;
  });

  it("is https, or http only on this machine, so the key never crosses a network in the clear", () => {
    for (const ok of [
      "https://unprompted.chat",
      "https://unprompted.chat/",
      "http://localhost:3000",
      "http://127.0.0.1:3000/",
    ]) {
      process.env.UNPROMPTED_URL = ok;
      expect(siteUrl(), ok).toBe(ok.replace(/\/+$/, ""));
    }
    for (const bad of [
      "http://unprompted.chat",
      "http://localhost.evil.test",
      "ftp://localhost",
      "not a url",
    ]) {
      process.env.UNPROMPTED_URL = bad;
      expect(() => siteUrl(), bad).toThrow();
    }
  });
});
