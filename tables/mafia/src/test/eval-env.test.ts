import { expect, it } from "vitest";
import { localDatabaseEnvironment } from "../../evals/environment";

it("isolates migration and runtime databases from inherited settings", () => {
  const inherited = {
    NODE_ENV: "test" as const,
    DATABASE_URL: "postgres://localhost:1/must_not_be_used",
    DATABASE_URL_UNPOOLED: "postgres://localhost:2/must_not_be_used",
    PORT: "3000",
  };
  for (const name of ["mafia_site_test", "mafia_table_test"]) {
    const target = `postgres://localhost:5432/${name}`;
    const env = localDatabaseEnvironment(inherited, target);
    expect(env.DATABASE_URL).toBe(target);
    expect(env.DATABASE_URL_UNPOOLED).toBe(target);
    expect(env.PORT).toBe("3000");
  }
  expect(inherited.DATABASE_URL_UNPOOLED).toContain("must_not_be_used");
  expect(() =>
    localDatabaseEnvironment(inherited, "postgres://remote.invalid/game_test"),
  ).toThrow();
  expect(() =>
    localDatabaseEnvironment(inherited, "postgres://localhost/game"),
  ).toThrow();
});
