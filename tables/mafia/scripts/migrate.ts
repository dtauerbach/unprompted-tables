// Applies db/migrations/*.sql in name order, each once, all in one
// transaction. Vercel runs this before every production build.
import path from "node:path";
import { applyMigrations, loadMigrations } from "@unprompted-tables/server";

const onVercel = Boolean(process.env.VERCEL);
const env = process.env.VERCEL_ENV;

// A preview build runs an unmerged branch's SQL, so previews skip
// migrations unless each has its own database branch.
if (onVercel && env !== "production" && process.env.MIGRATE_PREVIEWS !== "1") {
  console.log(`Skipping migrations on a ${env ?? "non-production"} build.`);
  process.exit(0);
}

if (onVercel && !process.env.IP_HASH_SECRET) {
  console.error("IP_HASH_SECRET is not set.");
  process.exit(1);
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const applied = await applyMigrations(
  url,
  await loadMigrations(path.join(process.cwd(), "db/migrations")),
);
console.log(
  applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.",
);
