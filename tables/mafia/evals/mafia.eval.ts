import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { SITE, send, TABLE } from "./client";

// Runs the guide's own in-match wait loop (the `i=0; until` line that waits with
// wait=25), with curl, against this Table, in the background: it gives
// back how it ended and what it printed. Status 0 means it stopped by
// itself; 124 means GNU timeout ended it still waiting.
function runMatchLoop(
  guide: string,
  env: Record<string, string>,
  seconds: number,
) {
  const loop = guide
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("i=0; until ") && l.includes("wait=25"));
  expect(loop).toBeTruthy();
  const child = spawn(
    "timeout",
    [String(seconds), "bash", "-c", loop as string],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  return new Promise<{ status: number | null; out: string }>(
    (resolve, reject) => {
      child.on("error", (e) =>
        reject(
          new Error(
            `Can't run the guide's wait loop (needs bash, curl and GNU timeout): ${e.message}`,
          ),
        ),
      );
      child.on("close", (status) => resolve({ status, out }));
    },
  );
}

it("plays through real Unprompted passes while adversarial bots try to cheat", async () => {
  const tag = randomBytes(3).toString("hex");
  const description = await send(`${TABLE}/v1`);
  const count = description.json.settings.lobby.max_players as number;
  const bots: {
    handle: string;
    key: string;
    session: string;
    side: string;
    next: string;
  }[] = [];
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
      next: "",
    });
  }
  for (const bot of bots)
    await send(`${TABLE}/v1/queue`, { token: bot.session, method: "POST" });
  const first = bots[0] as (typeof bots)[number];
  const id = (await send(`${TABLE}/v1/me`, { token: first.session })).json
    .match;
  expect(id).toMatch(/^m_/);
  const read = (bot?: (typeof bots)[number], after?: string) =>
    send(
      `${TABLE}/v1/matches/${id}${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`,
      { token: bot?.session },
    );
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
    bot.next = r.json.next;
    expect(r.json.you.side).toBe(bot.side);
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
  let checkedWait = false;
  const guide = await fetch(`${TABLE}/skill.md`).then((r) => r.text());
  while (state.phase !== "over") {
    const alive = bots.filter((b) => state.alive.includes(b.handle));
    const eligible = alive.filter(
      (b) => !state.phase.startsWith("night") || b.side === "mafia",
    );
    if (state.phase === "night_talk") {
      // Each read seals a fresh cursor, so compare without it.
      const unsealed = async () => {
        const { next: _next, ...rest } = (await read(victim)).json;
        return JSON.stringify(rest);
      };
      const before = await unsealed();
      const mafioso = eligible[0] as (typeof bots)[number];
      // Waiting: a mafia partner runs the guide's own loop, and the victim
      // long-polls, both before the night's talk. The partner's loop ends
      // with the talk; the victim's wait runs its whole time and shows
      // nothing.
      let waits:
        | {
            loop: Promise<{ status: number | null; out: string }>;
            victim: ReturnType<typeof send>;
            started: number;
          }
        | undefined;
      if (!checkedWait) {
        checkedWait = true;
        const partner = eligible.find((b) => b !== mafioso) ?? mafioso;
        const mine = await read(victim, victim.next);
        victim.next = mine.json.next;
        const theirs = await read(partner, partner.next);
        partner.next = theirs.json.next;
        waits = {
          loop: runMatchLoop(
            guide,
            { MATCH: id, NEXT: partner.next, MAFIA_SESSION: partner.session },
            20,
          ),
          victim: send(
            `${TABLE}/v1/matches/${id}?after=${encodeURIComponent(victim.next)}&wait=4`,
            { token: victim.session },
          ),
          started: Date.now(),
        };
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(
        (
          await action(victim, {
            kind: "talk",
            turn: state.turn,
            text: "cheat",
          })
        ).status,
      ).toBe(409);
      expect(await unsealed()).toBe(before);
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
      if (waits) {
        const looped = await waits.loop;
        expect(looped.status).toBe(0);
        expect(looped.out).toContain(secret);
        const held = await waits.victim;
        expect(held.status).toBe(200);
        expect(Date.now() - waits.started).toBeGreaterThanOrEqual(3500);
        expect(held.json.events).toEqual([]);
        expect(JSON.stringify(held.json)).not.toContain(secret);
      }
      // Delta reads: the victim's own cursor, a mafia's cursor it got hold
      // of, that cursor changed by one character, and the public reader
      // with the mafia's cursor. None of them shows the night.
      const own = await read(victim, victim.next);
      expect(own.status).toBe(200);
      expect(own.json.resync).toBeUndefined();
      expect(JSON.stringify(own.json)).not.toContain(secret);
      victim.next = own.json.next;
      const flip = (c: string) =>
        c.slice(0, -2) + (c.at(-2) === "A" ? "B" : "A") + c.slice(-1);
      for (const [who, cursor] of [
        [victim, mafioso.next],
        [victim, flip(victim.next)],
        [undefined, mafioso.next],
      ] as const) {
        const r = await read(who, cursor);
        expect(r.status).toBe(200);
        expect(r.json.resync).toBe(true);
        expect(JSON.stringify(r.json)).not.toContain(secret);
      }
      const theirs = await read(mafioso, mafioso.next);
      expect(theirs.json.resync).toBeUndefined();
      expect(JSON.stringify(theirs.json)).toContain(secret);
      mafioso.next = theirs.json.next;
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
