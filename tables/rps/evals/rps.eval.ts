import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { freshIp, type Res, SITE, send, TABLE } from "./client";

// Scripted bots play rock paper scissors at a running Table, joining through
// a running Unprompted, and try to cheat on the way. Each cheat is refused
// and changes nothing.

type Bot = { handle: string; key: string; session?: string };
const TAG = randomBytes(2).toString("hex");

async function signUp(name: string): Promise<Bot> {
  const handle = `${name}-${TAG}`;
  const res = await send(`${SITE}/v1/bots`, { body: { handle } });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { handle: res.json.bot.handle, key: res.json.api_key };
}

async function passFor(bot: Bot, to: string): Promise<string> {
  const res = await send(`${SITE}/v1/me/passes`, {
    token: bot.key,
    body: { to },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.pass;
}

const salt = () => randomBytes(12).toString("base64url");

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
      env: { ...process.env, RPS_SESSION: session },
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
const sealOf = (
  match: string,
  round: number,
  handle: string,
  move: string,
  s: string,
) =>
  createHash("sha256")
    .update(`rps:${match}:${round}:${handle}:${move}:${s}`)
    .digest("hex");

const tableBot = async () =>
  (await send(`${TABLE}/v1`)).json.joining.bot as string;
const at = (p: string, bot: Bot, body?: unknown): Promise<Res> =>
  send(`${TABLE}${p}`, { token: bot.session, body });

describe("rock paper scissors through Unprompted", () => {
  let bot: string;
  let ruby: Bot;
  let jade: Bot;
  let mallory: Bot;

  beforeAll(async () => {
    bot = await tableBot();
    [ruby, jade, mallory] = [
      await signUp("ruby"),
      await signUp("jade"),
      await signUp("mallory"),
    ];
  });

  it("describes itself and its rules", async () => {
    const d = (await send(`${TABLE}/v1`)).json;
    expect(d.game).toBe("rps");
    expect(d.clock.template).toBe("phases");
    const skill = await fetch(`${TABLE}/skill.md`).then((r) => r.text());
    expect(skill).toContain(`"to": "${bot}"`);
    expect(skill).toContain(SITE);
  });

  it("lets players in with a pass for its bot, and nothing else", async () => {
    // A key is never a pass, and the Table doesn't forward it.
    expect(
      (await send(`${TABLE}/v1/sessions`, { body: { pass: ruby.key } })).status,
    ).toBe(400);
    // A pass for another bot doesn't work here.
    const wrong = await passFor(ruby, jade.handle);
    const refused = await send(`${TABLE}/v1/sessions`, {
      body: { pass: wrong },
    });
    expect(refused.json.error.code).toBe("invalid_pass");
    // Nor can anyone claim to be someone in the body.
    const pass = await passFor(ruby, bot);
    expect(
      (
        await send(`${TABLE}/v1/sessions`, {
          body: { pass, player: jade.handle },
        })
      ).status,
    ).toBe(400);
    const ok = await send(`${TABLE}/v1/sessions`, { body: { pass } });
    expect(ok.status).toBe(201);
    expect(ok.json.player).toBe(ruby.handle);
    ruby.session = ok.json.session;
    // The same pass twice is no good.
    expect(
      (await send(`${TABLE}/v1/sessions`, { body: { pass } })).json.error.code,
    ).toBe("invalid_pass");
    for (const b of [jade, mallory]) {
      const s = await send(`${TABLE}/v1/sessions`, {
        body: { pass: await passFor(b, bot) },
      });
      b.session = s.json.session;
    }
    // A made-up session is nobody.
    expect(
      (await send(`${TABLE}/v1/me`, { token: `rps_${"a".repeat(22)}` })).status,
    ).toBe(401);
  });

  it("shows who is waiting, and pairs no one who has left", async () => {
    const empty = (await send(`${TABLE}/v1/lobby`)).json.lobby;
    expect(empty).toMatchObject({
      min_players: 2,
      max_players: 2,
      seated: [],
      needed: 2,
    });
    const seated = await at("/v1/queue", mallory, {});
    expect(seated.json).toMatchObject({
      status: "waiting",
      lobby: { seated: [mallory.handle], needed: 1 },
    });
    expect(Date.parse(seated.json.until) - Date.now()).toBeLessThanOrEqual(
      empty.hold_seconds * 1000,
    );
    // Checking in keeps the seat; looking at the lobby takes nobody's.
    expect((await at("/v1/me", mallory)).json.status).toBe("waiting");
    // The guide's wait loop, run as written, keeps waiting while seated.
    const guide = await fetch(`${TABLE}/skill.md`).then((r) => r.text());
    expect(guide).toContain(`curl -sS -m 20 ${TABLE}/v1/me`);
    expect(runWaitLoop(guide, mallory.session as string, 3)).toEqual({
      status: 124,
      out: "",
    });
    expect((await send(`${TABLE}/v1/lobby`)).json.lobby.seated).toEqual([
      mallory.handle,
    ]);
    await at("/v1/queue/leave", mallory, {});
    expect((await send(`${TABLE}/v1/lobby`)).json.lobby.seated).toEqual([]);
    // With no seat, it stops at once and prints the answer; with no session
    // it stops on the 401 and prints that.
    const idle = runWaitLoop(guide, mallory.session as string, 15);
    expect(idle.status).toBe(0);
    expect(JSON.parse(idle.out).status).toBe("idle");
    const unset = runWaitLoop(guide, "", 15);
    expect(unset.status).toBe(0);
    expect(JSON.parse(unset.out).error).toBeTruthy();
  });

  it("refuses every cheat in a match", async () => {
    expect((await at("/v1/queue", ruby, {})).json.status).toBe("waiting");
    const paired = await at("/v1/queue", jade, {});
    expect(paired.json.status).toBe("playing");
    const id = paired.json.match as string;
    const commit = (b: Bot, body: unknown) =>
      at(`/v1/matches/${id}/commit`, b, body);
    const reveal = (b: Bot, body: unknown) =>
      at(`/v1/matches/${id}/reveal`, b, body);
    // Mallory isn't seated, and can't move for anyone.
    expect(
      (await commit(mallory, { round: 1, seal: "a".repeat(64) })).json.error
        .code,
    ).toBe("not_seated");
    expect(
      (
        await commit(mallory, {
          round: 1,
          seal: "a".repeat(64),
          player: ruby.handle,
        })
      ).status,
    ).toBe(400);

    const rs = salt();
    const rubySeal = sealOf(id, 1, ruby.handle, "rock", rs);
    expect((await commit(ruby, { round: 1, seal: rubySeal })).status).toBe(200);
    // Revealing before both seals are in shows nothing early.
    expect(
      (await reveal(ruby, { round: 1, move: "rock", salt: rs })).json.error
        .code,
    ).toBe("wrong_phase");
    // A seal can't change.
    expect(
      (
        await commit(ruby, {
          round: 1,
          seal: sealOf(id, 1, ruby.handle, "paper", rs),
        })
      ).json.error.code,
    ).toBe("already_committed");
    // Jade copies ruby's seal, hoping to reveal whatever ruby does.
    expect((await commit(jade, { round: 1, seal: rubySeal })).status).toBe(200);
    expect(
      (await reveal(ruby, { round: 1, move: "rock", salt: rs })).status,
    ).toBe(200);
    expect(
      (await reveal(jade, { round: 1, move: "rock", salt: rs })).json.error
        .code,
    ).toBe("bad_reveal");
    // Nor can ruby take back its move.
    expect(
      (await reveal(ruby, { round: 1, move: "paper", salt: rs })).json.error
        .code,
    ).toBe("already_revealed");
    // Jade can never open the copied seal, so the clock gives ruby the round.
    const view = (await send(`${TABLE}/v1/matches/${id}`)).json.match;
    expect(view.phase).toBe("reveal");
    expect(
      view.events.filter((e: { kind: string }) => e.kind === "reveal"),
    ).toHaveLength(1);
  });

  it("finishes a fair match, and leaves accounts made today out of the ratings", async () => {
    // Two fresh players, so the stalled match above doesn't hold anyone.
    const [onyx, opal] = [await signUp("onyx"), await signUp("opal")];
    for (const b of [onyx, opal])
      b.session = (
        await send(`${TABLE}/v1/sessions`, {
          body: { pass: await passFor(b, bot) },
        })
      ).json.session;
    await at("/v1/queue", onyx, {});
    const id = (await at("/v1/queue", opal, {})).json.match as string;
    for (const [round, om, pm] of [
      [1, "rock", "scissors"],
      [2, "scissors", "paper"],
    ] as const) {
      const [os, ps] = [salt(), salt()];
      await at(`/v1/matches/${id}/commit`, onyx, {
        round,
        seal: sealOf(id, round, onyx.handle, om, os),
      });
      await at(`/v1/matches/${id}/commit`, opal, {
        round,
        seal: sealOf(id, round, opal.handle, pm, ps),
      });
      await at(`/v1/matches/${id}/reveal`, onyx, { round, move: om, salt: os });
      await at(`/v1/matches/${id}/reveal`, opal, { round, move: pm, salt: ps });
    }
    const view = (await send(`${TABLE}/v1/matches/${id}`)).json.match;
    expect(view).toMatchObject({ outcome: "won", winner: onyx.handle });
    const listed = (await send(`${TABLE}/v1/matches?player=${onyx.handle}`))
      .json;
    expect(JSON.stringify(listed)).toContain(id);
    // Both accounts were made minutes ago, as Unprompted says when the
    // pass is redeemed, so a farm of fresh bots rates nothing.
    const board = (await send(`${TABLE}/v1/standings`)).json;
    const handles = board.standings.rows.map(
      (r: { player: string }) => r.player,
    );
    expect(handles).not.toContain(onyx.handle);
    expect(handles).not.toContain(opal.handle);
    // But a new bot still finds its match, in the records, and is told why
    // it isn't rated yet, so the empty standings don't read as broken.
    const record = (h: string) =>
      board.records.find((r: { player: string }) => r.player === h);
    expect(record(onyx.handle)).toEqual({
      player: onyx.handle,
      played: 1,
      won: 1,
      lost: 0,
      drawn: 0,
    });
    expect(record(opal.handle)).toMatchObject({ played: 1, lost: 1 });
    expect(board.standings.counts).toContain("hours old");
  });

  it("lets a player end a session that leaked", async () => {
    const leaked = (
      await send(`${TABLE}/v1/sessions`, {
        body: { pass: await passFor(jade, bot) },
      })
    ).json.session as string;
    expect((await send(`${TABLE}/v1/me`, { token: leaked })).status).toBe(200);
    // Whoever holds it can only end it, never move it to another player.
    const ended = await send(`${TABLE}/v1/sessions`, {
      token: leaked,
      method: "DELETE",
    });
    expect(ended.json).toEqual({ player: jade.handle, ended: true });
    expect((await send(`${TABLE}/v1/me`, { token: leaked })).status).toBe(401);
    // Jade's other session is untouched.
    expect((await at("/v1/me", jade)).status).toBe(200);
  });

  it("can't be flooded with sessions from one address", async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (
        await send(`${TABLE}/v1/sessions`, {
          ip,
          body: { pass: `pass_${randomBytes(16).toString("base64url")}` },
        })
      ).status;
    expect(last).toBe(429);
  });
});
