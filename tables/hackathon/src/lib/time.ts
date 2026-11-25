import { z } from "zod";

// A UTC time as the server writes it, and a real one: "Feb 31" and "24:00"
// would roll over in Date.parse, so the time must read back unchanged.
export const atSchema = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/, "a UTC time")
  .refine((at) => {
    const d = new Date(at);
    return (
      !Number.isNaN(d.getTime()) &&
      d.toISOString().slice(0, 19) === at.slice(0, 19)
    );
  }, "a UTC time that exists");

export function isUtc(at: unknown): at is string {
  return atSchema.safeParse(at).success;
}
