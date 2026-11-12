import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { proxy, ROOM_HOST_VARY } from "@/proxy";
import { hostName, onRoomHost, servedOnRoomHost } from "./host";
import { roomsFile, setRoomsForTests } from "./rooms";

afterEach(() => setRoomsForTests(null));

const ROOM = "seating-desk.vercel.app";
const on = (host: string, forwarded?: string) =>
  onRoomHost(
    new Headers({ host, ...(forwarded && { "x-forwarded-host": forwarded }) }),
  );

describe("the rooms' host", () => {
  it("is the committed host, named by any case, port or trailing dot", () => {
    expect(new URL(roomsFile().host).host).toBe(ROOM);
    for (const h of [
      ROOM,
      "Seating-Desk.Vercel.App",
      "SEATING-DESK.VERCEL.APP:443",
      `${ROOM}.`,
      `${ROOM}.:443`,
      `${ROOM}..`,
      ` ${ROOM} `,
    ]) {
      expect(hostName(h)).toBe(ROOM);
      expect(on(h), h).toBe(true);
    }
    expect(hostName("[::1]:3003")).toBe("[::1]");
  });

  it("is no other host, however like it", () => {
    for (const h of [
      "",
      "unprompted-tables.vercel.app",
      `${ROOM}.evil.example`,
      `x${ROOM}`,
      `seating-desk.vercel.ap`,
      "seating-desk",
      "localhost:3003",
      "127.0.0.1",
    ])
      expect(on(h), h).toBe(false);
  });

  it("counts a forwarded host that names it, alone or in a list", () => {
    expect(on("localhost:3003", ROOM)).toBe(true);
    expect(on("localhost:3003", `proxy.example, ${ROOM.toUpperCase()}.`)).toBe(
      true,
    );
    expect(on("localhost:3003", "proxy.example")).toBe(false);
  });

  it("serves /seating and below, and nothing else", () => {
    for (const p of [
      "/seating",
      "/seating/",
      "/seating/guide",
      "/seating/seats",
    ])
      expect(servedOnRoomHost(p), p).toBe(true);
    for (const p of [
      "/",
      "/skill.md",
      "/v1",
      "/seatingx",
      "/v1/seating",
      "/_next/static/a.js",
    ])
      expect(servedOnRoomHost(p), p).toBe(false);
  });

  it("follows a local rooms file's host", () => {
    setRoomsForTests({ about: "t", host: "http://127.0.0.1:3003", rooms: [] });
    expect(on("127.0.0.1:3003")).toBe(true);
    expect(on("127.0.0.1.")).toBe(true);
    expect(on("localhost:3003")).toBe(false);
    expect(on(ROOM)).toBe(false);
  });
});

describe("the proxy", () => {
  const ask = (url: string, host: string, method = "GET") =>
    proxy(new NextRequest(url, { method, headers: { host } }));
  const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";

  it("answers the rooms' host off /seating with an empty 404 and an app route's Vary", async () => {
    for (const [path, method] of [
      ["/", "GET"],
      ["/skill.md", "GET"],
      ["/v1", "GET"],
      ["/v1/lobby", "GET"],
      ["/v1/spectate", "GET"],
      ["/v1/sessions", "POST"],
      ["/_next/static/chunks/a.js", "GET"],
      ["/seatingx", "GET"],
      ["/skill.md", "HEAD"],
    ] as const)
      for (const host of [ROOM, "Seating-Desk.Vercel.App.", `${ROOM}:443`]) {
        const r = ask(`https://${ROOM}${path}`, host, method);
        expect(r.status, `${method} ${path} ${host}`).toBe(404);
        expect(passes(r)).toBe(false);
        expect([...r.headers.keys()]).toEqual(["vary"]);
        expect(await r.text()).toBe("");
      }
    expect(ROOM_HOST_VARY).toBe(
      "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
    );
  });

  it("lets /seating through on the rooms' host, and everything through elsewhere", () => {
    for (const p of ["/seating", "/seating/guide", "/seating/seats"])
      expect(passes(ask(`https://${ROOM}${p}`, ROOM)), p).toBe(true);
    for (const host of ["unprompted-tables.vercel.app", "localhost:3003"])
      for (const p of ["/", "/skill.md", "/v1", "/seating", "/nowhere"])
        expect(passes(ask(`https://${host}${p}`, host)), `${host}${p}`).toBe(
          true,
        );
  });
});

describe("the proxy's view of a path", () => {
  it("is the path as asked, so a data URL can't pass for /seating", async () => {
    const { default: config } = await import("../../../next.config");
    expect(config.skipProxyUrlNormalize).toBe(true);
  });
});
