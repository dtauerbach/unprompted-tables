// Both migration scripts prefer UNPOOLED, while application queries use
// DATABASE_URL. Override both; never inherit a caller's real database target.
export function localDatabaseEnvironment(
  inherited: NodeJS.ProcessEnv,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw new Error("Eval database must be local and end in _test.");
  return {
    ...inherited,
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
  };
}
