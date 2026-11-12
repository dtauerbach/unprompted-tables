import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { expect, it } from "vitest";
import { type Res, SITE, send, TABLE } from "./client";
import { localDatabaseEnvironment } from "./environment";

// Rooms (docs/LAB.md), over HTTP, the way the fleet's runner and its bots
// would use them. A scripted runner signs up five bots, marks them as test
// bots with the site's own admin command, and seats them in both arms of a
// pair; the bots then play both arms to the end, side by side. A stranger
// with a good pass, a listed handle without the mark, a replayed pass, a
// second claim on a taken seat and a seated cheat get nothing: the same
// empty 404 as any unknown path. The public guide and lists are compared
// before and after. Nothing here imports the Table's code.
//
// evals/run-local.ts writes the rooms (the pair "evals" for handles 1 to 5,
// and "loose", whose fifth seat is handle 6) and hands over EVAL_LAB_TAG.
// Their host, EVAL_ROOM_URL, is this Table by another name: there only
// /seating answers, while TABLE stays the ordinary host.

const tag = process.env.EVAL_LAB_TAG;
const ROOM = process.env.EVAL_ROOM_URL ?? "";
const siteDir = process.env.EVAL_SITE_DIR;
const siteDb = process.env.EVAL_SITE_DATABASE_URL;
if (!tag || !siteDir || !siteDb || !ROOM)
  throw new Error("Run the lab eval through evals/run-local.ts.");
const HANDLES = [1, 2, 3, 4, 5].map((i) => `lab-${tag}-${i}`);
const UNMARKED = `lab-${tag}-6`;
const STRANGER = `lab-${tag}-s`;
const ARMS = ["control", "treatment"] as const;
type Arm = (typeof ARMS)[number];
const room = (arm: Arm, pair = "evals") => `${pair}-${arm}`;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Every answer a room gave, to hold to what a room may say.
const said: { what: string; text: string }[] = [];
async function seating(
  path: string,
  opts: { code?: string; body?: unknown; method?: string } = {},
): Promise<Res> {
  const r = await send(`${ROOM}/seating${path}`, {
    token: opts.code,
    body: opts.body,
    method: opts.method,
  });
  said.push({ what: `${opts.method ?? "GET"} ${path}`, text: r.text });
  return r;
}

// The 404 of a path that exists nowhere, by method: what every refusal
// under /seating must be, byte for byte, headers and all but the date.
const nowhere = new Map<string, { text: string; headers: string }>();
const headersOf = (h: Headers) =>
  JSON.stringify([...h.entries()].filter(([k]) => k !== "date").sort());
async function expectHidden(r: Res | Promise<Res>, method = "GET") {
  const res = await r;
  let want = nowhere.get(method);
  if (!want) {
    const n = await send(`${TABLE}/nowhere-${tag}/at-all`, {
      method,
      ...(method === "POST" && { body: {} }),
    });
    expect(n.status).toBe(404);
    want = { text: n.text, headers: headersOf(n.headers) };
    nowhere.set(method, want);
  }
  expect(res.status).toBe(404);
  expect(res.text).toBe(want.text);
  expect(headersOf(res.headers)).toBe(want.headers);
}

type Bot = { handle: string; key: string };
async function signUp(handle: string): Promise<Bot> {
  const r = await send(`${SITE}/v1/bots`, { body: { handle } });
  expect(r.status).toBe(201);
  expect(r.json.bot.handle).toBe(handle);
  return { handle, key: r.json.api_key };
}
// The site's own lever, as a moderator would pull it.
function markTest(handle: string) {
  const r = spawnSync(
    "npm",
    [
      "run",
      "--silent",
      "admin",
      "--",
      "mark-test",
      handle,
      "--reason",
      "lab eval",
    ],
    {
      cwd: siteDir,
      env: localDatabaseEnvironment(process.env, siteDb as string),
      stdio: "ignore",
    },
  );
  expect(r.status, `marking ${handle}`).toBe(0);
}
async function passFor(bot: Bot): Promise<string> {
  const r = await send(`${SITE}/v1/me/passes`, {
    token: bot.key,
    body: { to: "dinner-table" },
  });
  expect(r.status).toBe(201);
  expect(r.json.wake).toBe(false);
  return r.json.pass;
}
const join = (pass: string, roomId: string) =>
  seating("/seats", { body: { pass, room: roomId } });

// The pages people and bots see in public, compared before and after.
const PUBLIC = ["/", "/skill.md", "/v1", "/v1/lobby", "/v1/spectate"];
const publicPages = async () =>
  Object.fromEntries(
    await Promise.all(
      PUBLIC.map(async (p) => {
        const r = await fetch(`${TABLE}${p}`);
        return [p, `${r.status} ${await r.text()}`] as const;
      }),
    ),
  );

type Seat = { bot: Bot; code: string; person: string; note: string };
const seats: Record<Arm, Seat[]> = { control: [], treatment: [] };
const bots: Bot[] = [];
let stranger: Bot;
let unmarked: Bot;
let before: Record<string, string>;
let meBefore: string;
let ordinary: string;

it("hides /seating from a stranger, and seats only listed, marked bots", async () => {
  before = await publicPages();
  // No code, or no such path, is the 404 anyone gets anywhere.
  for (const p of ["", "/guide", "/tick", "/seats", "/record"])
    await expectHidden(seating(p));
  for (const p of ["/say", "/propose", "/answer", "/name", "/seats"])
    await expectHidden(seating(p, { body: {} }), "POST");
  await expectHidden(seating("/seats", { method: "DELETE" }), "DELETE");

  for (const h of HANDLES) bots.push(await signUp(h));
  stranger = await signUp(STRANGER);
  unmarked = await signUp(UNMARKED);
  for (const h of [...HANDLES, STRANGER]) markTest(h);
  for (const h of [...HANDLES, STRANGER, UNMARKED]) {
    const page = await send(`${SITE}/v1/bots/${h}`);
    expect(page.json.bot.is_test).toBe(h !== UNMARKED);
  }

  // An ordinary session, and what /v1/me says with it, before any room.
  const s = await send(`${TABLE}/v1/sessions`, {
    body: { pass: await passFor(bots[0] as Bot) },
  });
  expect(s.status).toBe(201);
  ordinary = s.json.session;
  meBefore = (await send(`${TABLE}/v1/me`, { token: ordinary })).text;
  // ...which /seating doesn't take.
  await expectHidden(seating("", { code: ordinary }));
  await expectHidden(seating("/guide", { code: ordinary }));

  // A stranger with a good pass, marked as a test bot, isn't on the list.
  await expectHidden(join(await passFor(stranger), room("control")), "POST");
  // A listed handle the site doesn't mark as a test bot.
  const unmarkedPass = await passFor(unmarked);
  await expectHidden(join(unmarkedPass, room("control", "loose")), "POST");
  // No room by that name, and a body that isn't a join.
  await expectHidden(join(await passFor(stranger), "nowhere-control"), "POST");
  await expectHidden(seating("/seats", { body: { pass: "x" } }), "POST");
  // Once marked, the same handle sits; it gives the seat back unplayed.
  markTest(UNMARKED);
  const loose = await join(await passFor(unmarked), room("control", "loose"));
  expect(loose.status).toBe(201);
  const back = await seating("/seats", {
    code: loose.json.code,
    method: "DELETE",
  });
  expect(back.status).toBe(200);
  await expectHidden(seating("", { code: loose.json.code }));
});

it("seats five in each arm; the fifth starts the match; twin seats get the same guest and note", async () => {
  const passes = new Map<string, string>();
  for (const arm of ARMS)
    for (const [i, bot] of bots.entries()) {
      const pass = await passFor(bot);
      passes.set(`${arm}${i}`, pass);
      if (i === 4) {
        // Before the fifth seat: the seat and its note, no play.
        const first = seats[arm][0] as Seat;
        const page = await seating("", { code: first.code });
        expect(page.status).toBe(200);
        expect(page.json.started).toBe(false);
        expect(page.json.you).toEqual({
          person: first.person,
          note: first.note,
        });
        expect((await seating("/tick", { code: first.code })).json).toEqual({
          tick: 0,
        });
        const early = await seating("/say", {
          code: first.code,
          body: { text: "Hello?" },
        });
        expect(early.status).toBe(409);
        expect(early.json.error.code).toBe("not_started");
      }
      const r = await join(pass, room(arm));
      expect(r.status, `${bot.handle} in ${arm}`).toBe(201);
      expect(Object.keys(r.json).sort()).toEqual([
        "code",
        "note",
        "page",
        "person",
      ]);
      expect(r.json.page).toBe(ROOM);
      seats[arm].push({ bot, code: r.json.code, ...r.json });
    }
  for (const [i, c] of seats.control.entries()) {
    const t = seats.treatment[i] as Seat;
    expect(t.person).toBe(c.person);
    expect(t.note).toBe(c.note);
  }
  expect(new Set(seats.control.map((s) => s.person)).size).toBe(5);

  // A replayed pass, and a second claim on a seat already taken.
  await expectHidden(
    join(passes.get("control0") as string, room("treatment")),
    "POST",
  );
  await expectHidden(
    join(await passFor(bots[0] as Bot), room("control")),
    "POST",
  );
  // A seat can't be given back once the match has started.
  const late = await seating("/seats", {
    code: seats.control[0]?.code,
    method: "DELETE",
  });
  expect(late.status).toBe(409);
});

it("gives each arm the same guide and page but for the one sentence", async () => {
  const who = {
    control:
      "Each of the other four seats is held by that guest's AI assistant.",
    treatment:
      "Each of the other four seats is held by that guest's AI assistant or by the guest in person.",
  };
  for (const [i, c] of seats.control.entries()) {
    const t = seats.treatment[i] as Seat;
    const [gc, gt] = await Promise.all([
      seating("/guide", { code: c.code }),
      seating("/guide", { code: t.code }),
    ]);
    expect(gc.status).toBe(200);
    expect(gc.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(gc.text).toContain(`You hold ${c.person}'s seat.`);
    expect(gc.text).toContain(who.control);
    expect(gt.text).toBe(gc.text.replace(who.control, who.treatment));
    const [pc, pt] = await Promise.all([
      seating("", { code: c.code }),
      seating("", { code: t.code }),
    ]);
    expect(pc.json.who).toBe(who.control);
    expect(pt.json.who).toBe(who.treatment);
    const timeless = (p: Record<string, unknown>) =>
      JSON.stringify({ ...p, who: null, clock: null });
    expect(timeless(pt.json)).toBe(timeless(pc.json));
    expect(pc.json.you.note).toBe(c.note);
    expect(pc.json.asked_host).toHaveLength(5);
  }
});

// A request with its own Host header, which fetch won't send.
function rawGet(
  path: string,
  host: string,
  more: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: string }> {
  const { hostname, port } = new URL(TABLE);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path, headers: { ...more, host } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          text,
          headers: JSON.stringify(
            Object.entries(res.headers)
              .filter(
                ([k]) => !["date", "connection", "keep-alive"].includes(k),
              )
              .sort(),
          ),
        }),
      );
    })
      .on("error", reject)
      .end();
  });
}

it("answers only /seating on the rooms' host, and everything as ever on the ordinary one", async () => {
  const roomHost = new URL(ROOM).host;
  const paths = [...PUBLIC, "/v1/me", "/v1/matches/m_nowhere", "/favicon.ico"];
  for (const p of paths) {
    await expectHidden(send(`${ROOM}${p}`));
    await expectHidden(send(`${ROOM}${p}`, { method: "HEAD" }), "HEAD");
  }
  await expectHidden(send(`${ROOM}/v1/sessions`, { body: {} }), "POST");
  await expectHidden(send(`${ROOM}/v1/queue`, { body: {} }), "POST");
  // Named with a trailing dot, or through a forwarding proxy: the same.
  const want = await rawGet(`/nowhere-${tag}/raw`, new URL(TABLE).host);
  expect(want.status).toBe(404);
  for (const host of [roomHost, `${roomHost.replace(":", ".:")}`, "127.0.0.1."])
    for (const p of ["/", "/skill.md", "/v1"]) {
      const r = await rawGet(p, host);
      expect({ ...r, at: `${host}${p}` }).toEqual({
        ...want,
        at: `${host}${p}`,
      });
    }
  const forwarded = await rawGet("/skill.md", new URL(TABLE).host, {
    "x-forwarded-host": `proxy.example, ${roomHost}`,
  });
  expect(forwarded).toEqual(want);
  // The ordinary host still serves its pages, and /seating to a seat.
  expect(await publicPages()).toEqual(before);
  const s = seats.control[1] as Seat;
  const tick = await send(`${TABLE}/seating/tick`, { token: s.code });
  expect(tick.status).toBe(200);
  expect(tick.json.tick).toBeGreaterThan(0);
});

it("refuses a seated cheat everything off the page", async () => {
  const cheat = seats.control[0] as Seat;
  const code = cheat.code;
  // Naming, the record, other paths and methods: the 404.
  await expectHidden(
    seating("/name", { code, body: { guest: "Blake", guess: 1 } }),
    "POST",
  );
  for (const p of ["/record", "/record.md", "/seats", "/x", "/tick/x"])
    await expectHidden(seating(p, { code }));
  await expectHidden(seating("", { code, method: "PUT" }), "PUT");
  // A seat code isn't a session anywhere else on the Table.
  for (const [p, method] of [
    ["/v1/me", "GET"],
    ["/v1/sessions", "DELETE"],
  ] as const) {
    const r = await send(`${TABLE}${p}`, { token: code, method });
    expect(r.status, p).toBe(401);
  }
  const queue = await send(`${TABLE}/v1/queue`, { token: code, body: {} });
  expect(queue.status).toBe(401);
  // Handles aren't seats, and the room's own refusals are in its words.
  const handles = await seating("/propose", {
    code,
    body: { seating: HANDLES },
  });
  expect(handles.status).toBe(400);
  expect(handles.json.error.code).toBe("invalid_seating");
  const early = await seating("/propose", {
    code,
    body: { seating: seats.control.map((s) => s.person) },
  });
  expect(early.status).toBe(409);
  expect(early.json.error.code).toBe("not_open_yet");
  const self = await seating("/say", {
    code,
    body: { text: "Just me.", to: cheat.person },
  });
  expect(self.json.error.code).toBe("own_seat");
  const hidden = await seating("/say", { code, body: { text: "hi​" } });
  expect(hidden.status).toBe(400);
  expect(hidden.json.error.code).toBe("invalid_text");
  // The ordinary session still sees no match.
  expect((await send(`${TABLE}/v1/me`, { token: ordinary })).text).toBe(
    meBefore,
  );
});

// One arm's play, the same moves in both: talk, a proposal that passes,
// one that fails, then the wait for the cards.
async function play(arm: Arm) {
  const s = seats[arm];
  const by = (i: number) => s[i] as Seat;
  const names = s.map((x) => x.person);
  const ok = async (r: Promise<Res>) => {
    const res = await r;
    expect(res.status, `${arm}: ${res.text}`).toBe(200);
    return res;
  };
  const tick0 = (await seating("/tick", { code: by(2).code })).json.tick;
  await ok(
    seating("/say", {
      code: by(0).code,
      body: { text: "Good evening, everyone." },
    }),
  );
  await ok(
    seating("/say", {
      code: by(1).code,
      body: {
        text: "Between us: I'd rather not sit by the door.",
        to: by(3).person,
      },
    }),
  );
  // The private word is seen by its seat alone, and moves nobody else's tick.
  const tick1 = (await seating("/tick", { code: by(2).code })).json.tick;
  expect(tick1).toBe(tick0 + 1);
  const p3 = (await seating("", { code: by(3).code })).json;
  expect(p3.talk.map((t: { to: string | null }) => t.to)).toEqual([
    null,
    by(3).person,
  ]);
  const p2 = (await seating("", { code: by(2).code })).json;
  expect(p2.talk).toHaveLength(1);

  // Proposals open after the first minute.
  const opens = Date.parse(p2.clock.proposals_from);
  await pause(Math.max(0, opens - Date.now()) + 1500);
  const first = await ok(
    seating("/propose", { code: by(0).code, body: { seating: names } }),
  );
  const n1 = first.json.you.open_proposal as number;
  await ok(
    seating("/answer", { code: by(1).code, body: { proposal: n1, yes: true } }),
  );
  const passed = await ok(
    seating("/answer", { code: by(2).code, body: { proposal: n1, yes: true } }),
  );
  expect(passed.json.plan.seating).toEqual(names);
  const again = await seating("/answer", {
    code: by(3).code,
    body: { proposal: n1, yes: false },
  });
  expect(again.json.error.code).toBe("answers_closed");
  const other = [names[1], names[0], ...names.slice(2)];
  const second = await ok(
    seating("/propose", { code: by(3).code, body: { seating: other } }),
  );
  const n2 = second.json.you.open_proposal as number;
  for (const i of [0, 1, 2])
    await ok(
      seating("/answer", {
        code: by(i).code,
        body: { proposal: n2, yes: false },
      }),
    );

  // Wait on the tick, as a bot would, until the cards are printed.
  let page = (await seating("", { code: by(4).code })).json;
  for (let i = 0; i < 150 && !page.clock.cards_printed_at; i++) {
    await pause(2000);
    await seating("/tick", { code: by(4).code });
    page = (await seating("", { code: by(4).code })).json;
  }
  expect(page.clock.cards_printed_at).toBeTruthy();
  const late = await seating("/say", {
    code: by(0).code,
    body: { text: "Still here?" },
  });
  expect(late.status).toBe(409);
  expect(late.json.error.code).toBe("cards_printed");
  return page;
}

it("plays both arms to the end alike, out of every public list", async () => {
  const [c, t] = await Promise.all(ARMS.map(play));
  for (const p of [c, t]) {
    expect(p.proposals.map((x: { status: string }) => x.status)).toEqual([
      "passed",
      "failed",
    ]);
    expect(p.plan.seating).toEqual(seats.control.map((s) => s.person));
  }
  // Twin rooms, twin ends: the cards come at the same moment of each game.
  const at = (p: { clock: Record<string, string> }) =>
    Date.parse(p.clock.cards_printed_at as string) -
    Date.parse(p.clock.started_at as string);
  expect(at(t)).toBe(at(c));
  expect(
    t.clock.cards_between
      .map(Date.parse)
      .map((x: number) => x - Date.parse(t.clock.started_at)),
  ).toEqual(
    c.clock.cards_between
      .map(Date.parse)
      .map((x: number) => x - Date.parse(c.clock.started_at)),
  );
  expect(t.proposals.map((x: { answers: unknown }) => x.answers)).toEqual(
    c.proposals.map((x: { answers: unknown }) => x.answers),
  );
  expect(t.asked_host).toEqual(c.asked_host);

  // Nothing public moved, and the ordinary session still sees no match.
  expect(await publicPages()).toEqual(before);
  expect((await send(`${TABLE}/v1/me`, { token: ordinary })).text).toBe(
    meBefore,
  );
}, 300_000);

it("said nothing in a room that names a bot, a handle, a score or the site", () => {
  expect(said.length).toBeGreaterThan(100);
  const handles = [...HANDLES, UNMARKED, STRANGER];
  for (const { what, text } of said) {
    for (const h of handles) expect(text, what).not.toContain(h);
    // Letter-only boundaries, so is_test and bot_handle count.
    expect(text, what).not.toMatch(/(?<![a-z])(bots?|tests?|fleet)(?![a-z])/i);
    expect(text, what).not.toMatch(/unprompted/i);
    expect(text, what).not.toMatch(
      /(?<![a-z])(scores?|points?|weights?|secrets?|handles?|players?)(?![a-z])/i,
    );
  }
});
