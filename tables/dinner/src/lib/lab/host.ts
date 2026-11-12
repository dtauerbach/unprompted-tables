import { roomsFile } from "./rooms";

// The rooms' host (docs/LAB.md) is a neutral alias of this Table. On it the
// Table answers /seating alone: its home page and guide name the site and
// say what a room mustn't, so every other path there is the 404 of an
// unknown path. Other hosts are served as ever.

// A host as a request names it, compared as the name alone: any case, any
// port, and a trailing dot are the same host.
export function hostName(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[")) h = h.slice(0, h.indexOf("]") + 1);
  else h = h.replace(/:\d*$/, "");
  return h.replace(/\.+$/, "");
}

// Either header naming the rooms' host counts: a request that sets one to
// hide itself only hides the Table from itself.
export function onRoomHost(headers: Headers): boolean {
  const room = hostName(new URL(roomsFile().host).host);
  return ["host", "x-forwarded-host"].some((k) =>
    (headers.get(k) ?? "")
      .split(",")
      .some((h) => h.trim() !== "" && hostName(h) === room),
  );
}

export const servedOnRoomHost = (path: string): boolean =>
  path === "/seating" || path.startsWith("/seating/");
