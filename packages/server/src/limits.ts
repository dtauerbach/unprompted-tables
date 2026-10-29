import type { Tx } from "./db";
import { ApiError } from "./http";

// Rate limits, counted in the rate_limits table a Table's first migration
// makes (see BASE_SQL in migrations.ts). Each Table picks its own rules.
export type Rule = {
  bucket: string;
  limit: number;
  windowSeconds: number;
  label: string;
};

// Counts one use against each rule, in the caller's transaction, so a
// request refused later in that transaction uses no quota.
export async function consume(tx: Tx, rules: Rule[]): Promise<void> {
  for (const r of rules) {
    const [row] = await tx<{ count: number; retry_after: number }[]>`
      INSERT INTO rate_limits (bucket, window_start, count)
      VALUES (
        ${r.bucket},
        to_timestamp(floor(extract(epoch FROM now()) / ${r.windowSeconds}) * ${r.windowSeconds}),
        1
      )
      ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
      RETURNING count,
        greatest(1, ceil(extract(epoch FROM (window_start + make_interval(secs => ${r.windowSeconds}) - now()))))::int
          AS retry_after`;
    if (row && row.count > r.limit) {
      console.warn(
        JSON.stringify({
          event: "rate_limited",
          rule: r.label,
          bucket: r.bucket,
        }),
      );
      throw new ApiError(
        429,
        "rate_limited",
        `Rate limit reached (${r.label}). Try again in ${row.retry_after} seconds.`,
        { "Retry-After": String(row.retry_after) },
      );
    }
  }
}
