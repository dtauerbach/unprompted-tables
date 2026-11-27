import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { localDatabaseEnvironment } from "./environment";

// Starts a local Unprompted and this Table, each on a database of its own
// made for this run, and runs evals/hackathon.eval.ts against them. Owns only
// the databases and child processes it creates: never drops a database it
// didn't make or kills whatever holds a port.
const siteDir = process.env.SITE_DIR;
if (!siteDir)
  throw new Error(
    "Set SITE_DIR to a local Unprompted checkout with npm ci completed.",
  );
const tableDir = path.resolve(import.meta.dirname, "..");
const adminUrl = new URL(
  process.env.HACKATHON_EVAL_POSTGRES_URL ??
    "postgres://postgres:postgres@localhost:5432/postgres",
);
if (!["localhost", "127.0.0.1"].includes(adminUrl.hostname))
  throw new Error("Eval Postgres must be local.");
const tag = randomBytes(4).toString("hex");
const names = [`hackathon_site_${tag}_test`, `hackathon_table_${tag}_test`];
const urls = names.map((name) => {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
});
const logs = path.join(tableDir, "evals/out", `local-${tag}`);
mkdirSync(logs, { recursive: true });
const children: ChildProcess[] = [];
const created: string[] = [];
const admin = postgres(adminUrl.toString(), { max: 1 });
const baseEnv = {
  ...process.env,
  IP_HASH_SECRET: `local-${tag}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

function launch(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: string,
) {
  const fd = openSync(path.join(logs, `${log}.log`), "a");
  const child = spawn("npm", args, {
    cwd,
    env,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  children.push(child);
  return child;
}
async function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: string,
) {
  const child = launch(cwd, args, env, log);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${log} failed; see ${logs}`)),
    );
  });
}
async function ready(url: string, child: ChildProcess) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited; see ${logs}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`server did not start; see ${logs}`);
}

try {
  // Refuse occupied ports; never drive another local service by mistake.
  for (const port of [3000, 3004])
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => server.close(() => resolve()));
    });
  for (const name of names) {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
  }
  const siteEnv = {
    ...localDatabaseEnvironment(baseEnv, urls[0] as string),
    PORT: "3000",
  };
  await run(siteDir, ["run", "migrate"], siteEnv, "site-migrate");
  await run(siteDir, ["run", "build"], siteEnv, "site-build");
  await ready(
    "http://localhost:3000/v1",
    launch(siteDir, ["start"], siteEnv, "site"),
  );
  const response = await fetch("http://localhost:3000/v1/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Real-IP": "10.251.0.1" },
    body: JSON.stringify({ handle: "hackathon-table" }),
  });
  if (!response.ok)
    throw new Error(`table bot registration: ${response.status}`);
  const registration = await response.json();
  const tableEnv = {
    ...localDatabaseEnvironment(baseEnv, urls[1] as string),
    PORT: "3004",
    UNPROMPTED_URL: "http://localhost:3000",
    UNPROMPTED_KEY: registration.api_key,
    UNPROMPTED_BOT: "hackathon-table",
  };
  await run(tableDir, ["run", "migrate"], tableEnv, "table-migrate");
  await run(tableDir, ["run", "build"], tableEnv, "table-build");
  await ready(
    "http://localhost:3004/v1",
    launch(tableDir, ["start"], tableEnv, "table"),
  );
  await run(
    tableDir,
    ["run", "eval"],
    {
      ...baseEnv,
      EVAL_SITE_URL: "http://localhost:3000",
      EVAL_TABLE_URL: "http://localhost:3004",
      EVAL_TAG: tag,
      // The eval lists its hackathons the way an operator does, with
      // `npm run list` against this Table's database.
      EVAL_TABLE_DATABASE_URL: urls[1] as string,
    },
    "eval",
  );
  console.log(`Hackathon end-to-end eval passed. Logs: ${logs}`);
  // KEEP_SERVERS=1 leaves both running to look at, until Ctrl-C.
  if (process.env.KEEP_SERVERS === "1")
    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
} finally {
  for (const child of children)
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  for (const name of created)
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
