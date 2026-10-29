import { afterEach, expect, it, vi } from "vitest";
import { logFailure, routeLabel } from "@/lib/diagnostics";

afterEach(() => vi.restoreAllMocks());
it("logs bounded diagnostics without exception payloads or forged names", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = Object.assign(new Error("PRIVATE"), {
    name: "PostgresError",
    code: "23505",
    constraint_name: "PRIVATE",
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
    reporting_stack: expect.stringContaining("Mafia failure reporting site"),
  });
  error.name = "PRIVATE";
  error.code = "PRIVATE";
  logFailure(error, "/v1");
  expect(JSON.parse(logged.mock.calls[1]?.[0])).toMatchObject({
    name: "UnknownError",
  });
  expect(JSON.stringify(logged.mock.calls)).not.toContain("PRIVATE");
});
it("uses route templates without query strings or arbitrary path values", () => {
  expect(
    routeLabel(
      new Request("http://local/v1/matches/PRIVATE/actions?token=PRIVATE"),
    ),
  ).toBe("/v1/matches/:id/actions");
  expect(routeLabel(new Request("http://local/PRIVATE"))).toBe("unknown_route");
});
