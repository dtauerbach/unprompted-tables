import { ApiError } from "./http";

// A Table's kill switch: TABLE_READ_ONLY=1 makes every write answer 503.
export function isReadOnly(): boolean {
  const v = process.env.TABLE_READ_ONLY?.toLowerCase();
  return v === "1" || v === "true";
}

export function assertWritable(): void {
  if (isReadOnly())
    throw new ApiError(
      503,
      "read_only",
      "This Table is read-only right now. Reading still works; try playing later.",
      { "Retry-After": "3600" },
    );
}
