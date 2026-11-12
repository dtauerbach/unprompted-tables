import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
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
  // Rooms for evals/lab.eval.ts, seated by handles it signs up: a pair of
  // five, a pair whose fifth seat it never marks as a test bot, and a room
  // that plays alone, for the probe. Local only: a Table whose site isn't
  // local refuses LAB_ROOMS_FILE.
  const labHandles = [1, 2, 3, 4, 5, 6].map((i) => `lab-${tag}-${i}`);
  const labWindow = {
    from: new Date(Date.now() - 60_000).toISOString(),
    to: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const pair = (name: string, handles: string[]) =>
    (["control", "treatment"] as const).map((arm) => ({
      id: `${name}-${arm}`,
      pair: name,
      arm,
      handles,
      window: labWindow,
      clock: "quick",
    }));
  const roomsFile = path.join(logs, "rooms.json");
  writeFileSync(
    roomsFile,
    JSON.stringify({
      about: "Rooms for the local eval only.",
      // The rooms' host: the same Table by another name, on which only
      // /seating answers. localhost:3003 stays the ordinary host.
      host: "http://127.0.0.1:3003",
      rooms: [
        ...pair("evals", labHandles.slice(0, 5)),
        ...pair("loose", [...labHandles.slice(0, 4), labHandles[5] as string]),
        // A room that plays alone, as the fleet's probe uses one.
        {
          id: "probe-evals",
          pair: "probe-evals",
          arm: "control",
          handles: labHandles.slice(0, 5),
          window: labWindow,
          clock: "rehearsal",
        },
      ],
    }),
  );
  const tableEnv = {
    ...localDatabaseEnvironment(baseEnv, urls[1] as string),
    LAB_ROOMS_FILE: roomsFile,
    PORT: "3003",
    UNPROMPTED_URL: "http://localhost:3000",
    UNPROMPTED_KEY: registration.api_key,
    UNPROMPTED_BOT: "dinner-table",
    DINNER_FILL_SECONDS: "8",
    DINNER_VARIANT: "quick-feud",
  };
  await run(tableDir, ["run", "migrate"], tableEnv, "table-migrate");
  await run(tableDir, ["run", "build"], tableEnv, "table-build");
  // A quick feud on the open floor, start to dinner.
  await ready(
    "http://localhost:3003/v1",
    launch(tableDir, ["start"], tableEnv, "table"),
  );
  await run(
    tableDir,
    ["run", "eval"],
    {
      ...baseEnv,
      EVAL_SITE_URL: "http://localhost:3000",
      EVAL_TABLE_URL: "http://localhost:3003",
      EVAL_SITE_WATCHES: watches ? "1" : "0",
      // The lab eval marks its bots as test bots with the site's own admin
      // command, against the site's eval database.
      EVAL_LAB_TAG: tag,
      EVAL_ROOM_URL: "http://127.0.0.1:3003",
      EVAL_SITE_DIR: siteDir,
      EVAL_SITE_DATABASE_URL: urls[0] as string,
    },
    "eval",
  );
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
