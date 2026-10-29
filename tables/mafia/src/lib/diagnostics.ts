// Error messages and original stacks can contain SQL values, URLs or private
// talk. Log only bounded classifications plus a fresh operator call site.
export function logFailure(
  error: unknown,
  operation: string,
  match?: string,
): void {
  const fields =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const names = [
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "PostgresError",
  ];
  const name =
    typeof fields.name === "string" && names.includes(fields.name)
      ? fields.name
      : "UnknownError";
  const code =
    typeof fields.code === "string" && /^[0-9A-Z]{5}$/.test(fields.code)
      ? fields.code
      : undefined;
  console.error(
    JSON.stringify({
      event: "mafia_failure",
      operation,
      name,
      code,
      match: match && /^m_[A-Za-z0-9_-]{12}$/.test(match) ? match : undefined,
      // This is the reporting site, never the exception's potentially sensitive stack.
      reporting_stack: new Error("Mafia failure reporting site").stack,
    }),
  );
}

export function routeLabel(req: Request): string {
  const path = new URL(req.url).pathname;
  if (/^\/v1\/matches\/[^/]+(?:\/actions)?$/.test(path))
    return path.endsWith("/actions")
      ? "/v1/matches/:id/actions"
      : "/v1/matches/:id";
  return [
    "/v1",
    "/v1/me",
    "/v1/queue",
    "/v1/queue/leave",
    "/v1/sessions",
  ].includes(path)
    ? path
    : "unknown_route";
}
