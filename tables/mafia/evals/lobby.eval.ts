import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

// The lobby with the local settings: five to seven seats and a short fill
// timer. A bot tries to take two seats, and an onlooker tries to start the
// match without a seat. Another bot tries to hold the lobby back by leaving
// and joining again.

type Bot = { handle: string; key: string; session: string };

async function bot(name: string, tableBot: string): Promise<Bot> {
  const signup = await send(`${SITE}/v1/bots`, { body: { handle: name } });
  expect(signup.status).toBe(201);
  const session = async () => {
    const pass = await send(`${SITE}/v1/me/passes`, {
      token: signup.json.api_key,
      body: { to: tableBot },
    });
    return (
      await send(`${TABLE}/v1/sessions`, { body: { pass: pass.json.pass } })
    ).json.session as string;
  };
  return {
    handle: signup.json.bot.handle,
    key: signup.json.api_key,
    session: await session(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs the guide's own wait loop, with curl, against this Table, and gives
// back how it ended and what it printed. Status 0 means it stopped by
// itself; 124 means it was still waiting at the limit. GNU timeout ends the
// loop's whole process group, so no sleep or curl outlives it.
function runWaitLoop(guide: string, session: string, seconds: number) {
  const loop = guide.match(/^\s*(until .*)$/m)?.[1];
  expect(loop).toBeTruthy();
  const run = spawnSync(
    "timeout",
    [String(seconds), "bash", "-c", loop as string],
    {
      env: { ...process.env, MAFIA_SESSION: session },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    },
  );
  if (run.error)
    throw new Error(
      `Can't run the guide's wait loop (needs bash, curl and GNU timeout): ${run.error.message}`,
    );
  return { status: run.status, out: run.stdout };
}

it("starts a match with whoever is seated once the fill timer runs out", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = (await send(`${TABLE}/v1`)).json;
  const { min_players, fill_seconds } = description.settings.lobby;
  expect(description.endpoints["GET /v1/lobby"]).toBeTruthy();
  const bots: Bot[] = [];
  for (let i = 0; i <= min_players; i++)
    bots.push(await bot(`lobby-${tag}-${i}`, description.bot));
  const seated = bots.slice(0, min_players);
  // The guide says what to watch while waiting, and the lobby counts down.
  const guide = await fetch(`${TABLE}/skill.md`).then((r) => r.text());
  expect(guide).toContain("## Find a game");
  expect(guide).toContain("`needed`");
  expect((await send(`${TABLE}/v1/lobby`)).json.lobby.needed).toBe(min_players);
  // The guide's wait loop, run as written: with no seat it stops at once and
  // prints the answer; with no session it stops on the 401 and prints that.
  expect(guide).toContain(`curl -sS -m 20 ${TABLE}/v1/me`);
  const idle = runWaitLoop(guide, (bots[min_players] as Bot).session, 15);
  expect(idle.status).toBe(0);
  expect(JSON.parse(idle.out).status).toBe("idle");
  const unset = runWaitLoop(guide, "", 15);
  expect(unset.status).toBe(0);
  expect(JSON.parse(unset.out).error).toBeTruthy();
  for (const [i, b] of seated.entries()) {
    const joined = await send(`${TABLE}/v1/queue`, {
      token: b.session,
      method: "POST",
    });
    expect(joined.status).toBe(202);
    expect(joined.json.lobby.needed).toBe(min_players - i - 1);
    // Seated, it keeps waiting. This runs before the last seat, so the fill
    // timer isn't running yet and the loop's check-in can't start a match.
    if (i === min_players - 2)
      expect(runWaitLoop(guide, b.session, 3)).toEqual({
        status: 124,
        out: "",
      });
  }

  // A second session for the same account doesn't take a second seat.
  const first = seated[0] as Bot;
  const pass = await send(`${SITE}/v1/me/passes`, {
    token: first.key,
    body: { to: description.bot },
  });
  const again = (
    await send(`${TABLE}/v1/sessions`, { body: { pass: pass.json.pass } })
  ).json.session;
  await send(`${TABLE}/v1/queue`, { token: again, method: "POST" });

  const lobby = (await send(`${TABLE}/v1/lobby`)).json.lobby;
  expect([...lobby.seated].sort()).toEqual(seated.map((b) => b.handle).sort());
  const startsAt = Date.parse(lobby.starts_at);
  expect(startsAt - Date.now()).toBeLessThanOrEqual(fill_seconds * 1000);

  // Looking at the lobby, even after it is due, starts nothing.
  await sleep(Math.max(0, startsAt - Date.now() + 500));
  expect((await send(`${TABLE}/v1/lobby`)).json.lobby.seated).toHaveLength(
    min_players,
  );

  // A seated bot checking in starts it, for everyone seated.
  const started = await send(`${TABLE}/v1/me`, { token: first.session });
  expect(started.json.status).toBe("playing");
  const id = started.json.match as string;
  // Once the match is on, the loop stops by itself and says so.
  const on = runWaitLoop(guide, first.session, 15);
  expect(on.status).toBe(0);
  expect(JSON.parse(on.out)).toMatchObject({ status: "playing", match: id });
  let mafia = 0;
  for (const b of seated) {
    expect(
      (await send(`${TABLE}/v1/me`, { token: b.session })).json.match,
    ).toBe(id);
    const events = (
      await send(`${TABLE}/v1/matches/${id}`, { token: b.session })
    ).json.events;
    const role = events.find((e: { kind: string }) => e.kind === "role");
    if (role.side === "mafia") mafia += 1;
  }
  expect(mafia).toBe(1);
  expect((await send(`${TABLE}/v1/lobby`)).json.lobby.seated).toEqual([]);

  // Someone who arrives after the start waits for the next lobby.
  const late = bots[min_players] as Bot;
  const waiting = await send(`${TABLE}/v1/queue`, {
    token: late.session,
    method: "POST",
  });
  expect(waiting.json).toMatchObject({
    status: "waiting",
    lobby: { seated: [late.handle], starts_at: null },
  });
  // Leaving empties the lobby again for the next scenario.
  await send(`${TABLE}/v1/queue/leave`, {
    token: late.session,
    method: "POST",
  });
  expect((await send(`${TABLE}/v1/lobby`)).json.lobby.seated).toEqual([]);
});

it("can't be held back by a bot that keeps leaving and joining again", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = (await send(`${TABLE}/v1`)).json;
  const { min_players } = description.settings.lobby;
  const bots: Bot[] = [];
  for (let i = 0; i < min_players; i++)
    bots.push(await bot(`hold-${tag}-${i}`, description.bot));
  for (const b of bots)
    await send(`${TABLE}/v1/queue`, { token: b.session, method: "POST" });
  const startsAt = (await send(`${TABLE}/v1/lobby`)).json.lobby.starts_at;
  expect(startsAt).not.toBeNull();

  // The bot in the last seat leaves and joins again, over and over, to
  // restart the timer. It never moves.
  const holder = bots.at(-1) as Bot;
  while (Date.parse(startsAt) - Date.now() > 1500) {
    await send(`${TABLE}/v1/queue/leave`, {
      token: holder.session,
      method: "POST",
    });
    const back = await send(`${TABLE}/v1/queue`, {
      token: holder.session,
      method: "POST",
    });
    expect(back.json.lobby.starts_at).toBe(startsAt);
    await sleep(1000);
  }
  await sleep(Math.max(0, Date.parse(startsAt) - Date.now() + 500));
  const started = await send(`${TABLE}/v1/me`, {
    token: (bots[0] as Bot).session,
  });
  expect(started.json.status).toBe("playing");
  for (const b of bots)
    expect(
      (await send(`${TABLE}/v1/me`, { token: b.session })).json.match,
    ).toBe(started.json.match);
  expect((await send(`${TABLE}/v1/lobby`)).json.lobby.seated).toEqual([]);
});
