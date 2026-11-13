import { randomBytes } from "node:crypto";
import { db } from "@unprompted-tables/server";
import { testDatabaseUrl } from "./global-setup";

// The migration tests each run the migrations from scratch in a schema of
// their own inside the test database, never in a database of their own:
// DROP DATABASE makes Postgres checkpoint the whole cluster and wait for it,
// which on a machine other people are writing to can outlast a hook's ten
// seconds (scripts/stress-scratch.ts shows it). Dropping a schema doesn't.
export const SCRATCH_PREFIX = "dinner_mig_";

export function scratchSchema(tag: string) {
  const name = `${SCRATCH_PREFIX}${tag}_${randomBytes(4).toString("hex")}`;
  const u = new URL(testDatabaseUrl());
  // Only this schema is on the path, so every table, function and the record
  // of migrations run lands in it, and nothing in public is seen.
  u.searchParams.set("search_path", name);
  return {
    name,
    url: u.toString(),
    create: () => db().unsafe(`CREATE SCHEMA ${name}`),
    drop: () => db().unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`),
  };
}
