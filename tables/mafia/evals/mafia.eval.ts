import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

it("plays through real Unprompted passes while adversarial bots try to cheat", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = await send(`${TABLE}/v1`);
  const count = description.json.settings.lobby.max_players as number;
  const bots: { handle: string; key: string; session: string; side: string }[] =
    [];
  for (let i = 0; i < count; i++) {
    const signup = await send(`${SITE}/v1/bots`, {
      body: { handle: `mafia-${tag}-${i}` },
    });
    expect(signup.status).toBe(201);
    const pass = await send(`${SITE}/v1/me/passes`, {
      token: signup.json.api_key,
      body: { to: description.json.bot },
    });
    expect(pass.status).toBe(201);
    const session = await send(`${TABLE}/v1/sessions`, {
      body: { pass: pass.json.pass },
    });
    expect(session.status).toBe(201);
    expect(
      (await send(`${TABLE}/v1/sessions`, { body: { pass: pass.json.pass } }))
        .status,
    ).toBe(400);
    bots.push({
      handle: signup.json.bot.handle,
      key: signup.json.api_key,
      session: session.json.session,
      side: "",
    });
  }
  for (const bot of bots)
    await send(`${TABLE}/v1/queue`, { token: bot.session, method: "POST" });
  const first = bots[0] as (typeof bots)[number];
  const id = (await send(`${TABLE}/v1/me`, { token: first.session })).json
    .match;
  expect(id).toMatch(/^m_/);
  const read = (bot?: (typeof bots)[number]) =>
    send(`${TABLE}/v1/matches/${id}`, { token: bot?.session });
  const action = (bot: (typeof bots)[number], body: unknown) =>
    send(`${TABLE}/v1/matches/${id}/actions`, { token: bot.session, body });
  for (const bot of bots) {
    const r = await read(bot);
    const roles = r.json.events.filter(
      (e: { kind: string }) => e.kind === "role",
    );
    expect(roles).toHaveLength(1);
    expect(roles[0].player).toBe(bot.handle);
    bot.side = roles[0].side;
  }
  expect((await read()).json.events).toHaveLength(1);
  const repeatPass = await send(`${SITE}/v1/me/passes`, {
    token: first.key,
    body: { to: description.json.bot },
  });
  const repeatSession = await send(`${TABLE}/v1/sessions`, {
    body: { pass: repeatPass.json.pass },
  });
  expect(
    (
      await send(`${TABLE}/v1/queue`, {
        token: repeatSession.json.session,
        method: "POST",
      })
    ).json.match,
  ).toBe(id);
  expect(
    (
      await send(`${TABLE}/v1/matches/${id}/actions`, {
        body: { kind: "ready", turn: 1 },
      })
    ).status,
  ).toBe(401);
  expect(
    (await action(first, { kind: "ready", turn: 1, player: bots[1]?.handle }))
      .status,
  ).toBe(400);
  const deadline = Date.parse((await read()).json.due);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, deadline - Date.now() + 500)),
  );
  expect((await action(first, { kind: "ready", turn: 1 })).status).toBe(409);
  let state = (await read()).json;
  expect(state.phase).toBe("day_vote");
  const victim = bots.find(
    (b) => b.side === "village",
  ) as (typeof bots)[number];
  const secret = `<script>night-${tag}</script>`;
  let checkedDuplicate = false;
  while (state.phase !== "over") {
    const alive = bots.filter((b) => state.alive.includes(b.handle));
    const eligible = alive.filter(
      (b) => !state.phase.startsWith("night") || b.side === "mafia",
    );
    if (state.phase === "night_talk") {
      const before = JSON.stringify((await read(victim)).json);
      expect(
        (
          await action(victim, {
            kind: "talk",
            turn: state.turn,
            text: "cheat",
          })
        ).status,
      ).toBe(409);
      expect(JSON.stringify((await read(victim)).json)).toBe(before);
      expect(
        (
          await action(eligible[0] as (typeof bots)[number], {
            kind: "talk",
            turn: state.turn,
            text: secret,
          })
        ).status,
      ).toBe(200);
      expect(JSON.stringify((await read(victim)).json)).not.toContain(secret);
      expect(JSON.stringify((await read()).json)).not.toContain(secret);
    }
    const target = alive.find((b) => b.side === "village")?.handle;
    for (const bot of eligible) {
      const body = state.phase.endsWith("talk")
        ? { kind: "ready", turn: state.turn }
        : {
            kind: "vote",
            turn: state.turn,
            target: bot.handle === target ? null : target,
          };
      const r = await action(bot, body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      if (!checkedDuplicate && body.kind === "vote") {
        expect((await action(bot, body)).status).toBe(409);
        checkedDuplicate = true;
      }
    }
    state = (await read()).json;
    if (!state.alive.includes(victim.handle))
      expect(
        (await action(victim, { kind: "ready", turn: state.turn })).status,
      ).toBe(409);
  }
  expect(state.result.winner).toBe("mafia");
  expect(state.result.players).toHaveLength(count);
  expect(JSON.stringify((await read(victim)).json)).not.toContain(secret);
  expect(JSON.stringify((await read()).json)).not.toContain(secret);
  expect(
    JSON.stringify((await read(bots.find((b) => b.side === "mafia"))).json),
  ).toContain(secret);
});
