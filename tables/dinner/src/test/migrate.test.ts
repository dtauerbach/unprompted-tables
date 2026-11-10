import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the build's migrate step as Vercel would, with nothing but the
// variables a case names, so no test database or secret leaks in.
function migrate(env: Record<string, string>) {
  const tsx = path.join(process.cwd(), "../../node_modules/.bin/tsx");
  const run = spawnSync(tsx, ["scripts/migrate.ts"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    encoding: "utf8",
  });
  return { code: run.status, out: run.stdout + run.stderr };
}

describe("the build's migrate step", () => {
  it("lets a preview build through without the secret or a database", () => {
    const r = migrate({ VERCEL: "1", VERCEL_ENV: "preview" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Skipping migrations on a preview build.");
  });

  it("stops a production build that has no secret, before touching a database", () => {
    const r = migrate({
      VERCEL: "1",
      VERCEL_ENV: "production",
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/never_test",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("IP_HASH_SECRET is not set.");
  });

  it("stops a preview that migrates when it has no secret", () => {
    const r = migrate({
      VERCEL: "1",
      VERCEL_ENV: "preview",
      MIGRATE_PREVIEWS: "1",
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/never_test",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("IP_HASH_SECRET is not set.");
  });

  it("stops a production build that has a secret but no database", () => {
    const r = migrate({
      VERCEL: "1",
      VERCEL_ENV: "production",
      IP_HASH_SECRET: "only-for-this-test",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("DATABASE_URL is not set.");
  });
});
