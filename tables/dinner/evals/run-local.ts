import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { localDatabaseEnvironment } from "./environment";

// Own only the databases and child processes created by this run. Never
// drop a pre-existing database or kill whatever happens to own a port.
const siteDir = process.env.SITE_DIR;
if (!siteDir)
  throw new Error(
    "Set SITE_DIR to a local Unprompted checkout with npm ci completed.",
  );
const tableDir = path.resolve(import.meta.dirname, "..");
const adminUrl = new URL(
  process.env.DINNER_EVAL_POSTGRES_URL ??
    "postgres://postgres:postgres@localhost:5432/postgres",
);
if (!["localhost", "127.0.0.1"].includes(adminUrl.hostname))
  throw new Error("Eval Postgres must be local.");
const tag = randomBytes(4).toString("hex");
const names = [`dinner_site_${tag}_test`, `dinner_table_${tag}_test`];
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
  // Refuse occupied ports; do not accidentally drive another local service.
  for (const port of [3000, 3003]) {
    const { createServer } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => server.close(() => resolve()));
    });
  }
  for (const name of names) {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    created.push(name);
  }
  // A site new enough to draw spectator feeds is pointed at this Table, so
  // the eval can check the page people see; an older one is left as it is.
  const watches = existsSync(path.join(siteDir, "src/lib/spectate.ts"));
  const siteEnv = {
    ...localDatabaseEnvironment(baseEnv, urls[0] as string),
    PORT: "3000",
    ...(watches && {
      UNPROMPTED_LOCAL_TABLES: JSON.stringify([
        {
          slug: "dinner",
          name: "Dinner party",
          url: "http://localhost:3003/v1/spectate",
        },
      ]),
    }),
  };
  await run(siteDir, ["run", "migrate"], siteEnv, "site-migrate");
  await run(siteDir, ["run", "build"], siteEnv, "site-build");
  await ready(
    "http://localhost:3000/v1",
    launch(siteDir, ["start"], siteEnv, "site"),
  );
  const response = await fetch("http://localhost:3000/v1/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Real-IP": "10.250.0.1" },
    body: JSON.stringify({ handle: "dinner-table" }),
  });
  if (!response.ok)
    throw new Error(`table bot registration: ${response.status}`);
  const registration = await response.json();
  const tableEnv = {
    ...localDatabaseEnvironment(baseEnv, urls[1] as string),
    PORT: "3003",
    UNPROMPTED_URL: "http://localhost:3000",
    UNPROMPTED_KEY: registration.api_key,
    UNPROMPTED_BOT: "dinner-table",
    DINNER_FILL_SECONDS: "8",
    DINNER_VARIANT: "quick-compromise",
  };
  await run(tableDir, ["run", "migrate"], tableEnv, "table-migrate");
  await run(tableDir, ["run", "build"], tableEnv, "table-build");
  // A quick compromise first, then a quick mix, each on a fresh start of
  // the Table under that variant.
  for (const [variant, label] of [
    ["quick-compromise", "compromise"],
    ["quick-mix", "mix"],
  ] as const) {
    const table = launch(
      tableDir,
      ["start"],
      { ...tableEnv, DINNER_VARIANT: variant },
      `table-${label}`,
    );
    await ready("http://localhost:3003/v1", table);
    await run(
      tableDir,
      ["run", "eval"],
      {
        ...baseEnv,
        EVAL_SITE_URL: "http://localhost:3000",
        EVAL_TABLE_URL: "http://localhost:3003",
        EVAL_SITE_WATCHES: watches ? "1" : "0",
        EVAL_VARIANT: label,
      },
      `eval-${label}`,
    );
    if (label === "mix" && process.env.KEEP_SERVERS === "1") break;
    // Stop this Table before the next one takes the port.
    const gone = new Promise((resolve) => table.once("exit", resolve));
    if (table.pid) process.kill(-table.pid, "SIGTERM");
    await gone;
  }
  console.log(`Dinner table end-to-end eval passed. Logs: ${logs}`);
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
