// Error messages and original stacks can contain SQL values, URLs or private
// talk. Log only explicitly recognized classifications. Catalog identifiers
// are also omitted: syntax alone does not establish that a value is safe.
const ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "22001",
  "22P02",
  "23502",
  "23503",
  "23505",
  "23514",
  "40001",
  "40P01",
  "42501",
  "42703",
  "42P01",
  "53300",
  "57014",
  "57P01",
  "57P02",
  "57P03",
]);
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
    "ZodError",
    "AggregateError",
    "TimeoutError",
  ];
  const name =
    typeof fields.name === "string" && names.includes(fields.name)
      ? fields.name
      : "UnknownError";
  const code =
    typeof fields.code === "string" && ERROR_CODES.has(fields.code)
      ? fields.code
      : undefined;
  console.error(
    JSON.stringify({
      event: "mafia_failure",
      operation,
      name,
      code,
      match: match && /^m_[A-Za-z0-9_-]{12}$/.test(match) ? match : undefined,
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
