import { afterEach, expect, it, vi } from "vitest";
import { logFailure, routeLabel } from "@/lib/diagnostics";
import { route } from "@/lib/http";

afterEach(() => vi.restoreAllMocks());
it("logs bounded diagnostics without exception payloads or forged names", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(new Error("PRIVATE"), {
    name: "PostgresError",
    code: "23505",
    constraint_name: "private_night_talk",
    table_name: "private_night_talk",
    column_name: "private_night_talk",
    detail: "PRIVATE",
    parameters: ["PRIVATE"],
    query: "PRIVATE",
    where: "PRIVATE",
    hint: "PRIVATE",
    internal_query: "PRIVATE",
    stack: "PRIVATE",
    cause: new Error("PRIVATE"),
  });
  logFailure(error, "sweep_match", "m_aaaaaaaaaaaa");
  expect(JSON.parse(logged.mock.calls[0]?.[0])).toMatchObject({
    name: "PostgresError",
    code: "23505",
    operation: "sweep_match",
    match: "m_aaaaaaaaaaaa",
  });
  error.name = "PRIVATE";
  error.code = "PRIVATE";
  logFailure(error, "/v1");
  expect(JSON.parse(logged.mock.calls[1]?.[0])).toMatchObject({
    name: "UnknownError",
  });
  for (const code of ["ABCDE", "PRIVATE", "private_night_talk", "23599"]) {
    logFailure({ code }, "/v1");
    expect(JSON.parse(logged.mock.calls.at(-1)?.[0])).not.toHaveProperty(
      "code",
    );
  }
  expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE");
  expect(JSON.stringify(logged.mock.calls)).not.toContain("private_night_talk");
});
it("uses route templates without query strings or arbitrary path values", () => {
  expect(
    routeLabel(
      new Request("http://local/v1/matches/PRIVATE/actions?token=PRIVATE"),
    ),
  ).toBe("/v1/matches/:id/actions");
  expect(routeLabel(new Request("http://local/PRIVATE"))).toBe("unknown_route");
});

it.each([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "CONNECTION_CLOSED",
  "CONNECT_TIMEOUT",
  "22P02",
])("retains known diagnostic code %s", (code) => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  logFailure(Object.assign(new Error("private"), { code }), "/v1");
  expect(JSON.parse(logged.mock.calls[0]?.[0])).toEqual({
    event: "mafia_failure",
    operation: "/v1",
    name: "Error",
    code,
  });
});
it.each([
  "ZodError",
  "AggregateError",
  "TimeoutError",
])("classifies %s without its payload", (name) => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  logFailure({ name, message: "private", issues: ["private"] }, "/v1");
  expect(JSON.parse(logged.mock.calls[0]?.[0])).toEqual({
    event: "mafia_failure",
    operation: "/v1",
    name,
  });
});

it("labels unexpected lobby failures without logging query data", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const handler = route(async () => {
    throw new Error("PRIVATE");
  });
  const response = await handler(
    new Request("http://local/v1/lobby?token=PRIVATE"),
    undefined,
  );
  expect(response.status).toBe(500);
  expect(JSON.parse(logged.mock.calls[0]?.[0])).toEqual({
    event: "mafia_failure",
    operation: "/v1/lobby",
    name: "Error",
  });
  expect(await response.text()).not.toContain("PRIVATE");
});
