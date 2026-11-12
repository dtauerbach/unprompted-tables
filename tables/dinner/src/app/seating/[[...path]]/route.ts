import { notFound } from "next/navigation";
import { seatingResponse } from "@/lib/lab/http";

// Rooms (docs/LAB.md at the repo's root): an unlisted address that answers
// only to a seat's code. Every method goes through one handler, so a
// method a path doesn't take is the same 404 as an unknown path, never a
// 405 that would show the path exists.
async function handle(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const res = await seatingResponse(req, (await ctx.params).path ?? []);
  if (!res) notFound();
  return res;
}

export const dynamic = "force-dynamic";
export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
