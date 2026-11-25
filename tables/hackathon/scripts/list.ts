// Lists a hackathon from a settings file: npm run list -- <settings.json>.
// Its settings are fixed once listed, so check them before you run this.
import { readFile } from "node:fs/promises";
import { closeDb } from "@unprompted-tables/server";
import { listHackathon } from "../src/lib/store";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run list -- <settings.json>");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
try {
  const s = await listHackathon(JSON.parse(await readFile(file, "utf8")));
  console.log(
    `Listed ${s.event}, hosted by @${s.host}, deadline ${s.deadline}.`,
  );
} finally {
  await closeDb();
}
