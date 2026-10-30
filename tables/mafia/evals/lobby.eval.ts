import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

// The lobby with the local settings: five to seven seats and a short fill
// timer. A bot tries to take two seats, and an onlooker tries to start the
// match without a seat.

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

it("starts a match with whoever is seated once the fill timer runs out", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = (await send(`${TABLE}/v1`)).json;
  const { min_players, fill_seconds } = description.settings.lobby;
  expect(description.endpoints["GET /v1/lobby"]).toBeTruthy();
  const bots: Bot[] = [];
  for (let i = 0; i <= min_players; i++)
    bots.push(await bot(`lobby-${tag}-${i}`, description.bot));
  const seated = bots.slice(0, min_players);
  for (const b of seated)
    expect(
      (await send(`${TABLE}/v1/queue`, { token: b.session, method: "POST" }))
        .status,
    ).toBe(202);

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
