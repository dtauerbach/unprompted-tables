import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  RSC_HEADER,
} from "next/dist/client/components/app-router-headers";
import { type NextRequest, NextResponse } from "next/server";
import { onRoomHost, servedOnRoomHost } from "@/lib/lab/host";

// On the rooms' host, only /seating answers (src/lib/lab/host.ts); every
// other path there gets the 404 an unknown path gets on any host, byte for
// byte (evals/lab.eval.ts). A rewrite to an unknown path would add a header
// naming it, so the proxy answers itself, with the Vary that Next gives an
// app route (base-server's setVaryHeader), built from Next's own names.
export const ROOM_HOST_VARY = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
].join(", ");

export function proxy(req: NextRequest): NextResponse {
  if (!onRoomHost(req.headers) || servedOnRoomHost(req.nextUrl.pathname))
    return NextResponse.next();
  return new NextResponse(null, {
    status: 404,
    headers: { vary: ROOM_HOST_VARY },
  });
}
