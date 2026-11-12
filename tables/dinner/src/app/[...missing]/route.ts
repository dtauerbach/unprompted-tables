import { notFound } from "next/navigation";

// Every path this Table doesn't serve, whatever the method, is the same
// empty 404. /seating answers its refusals with this very 404 (docs/LAB.md
// at the repo's root), so nothing tells a stranger the path exists.
// Async, as /seating's handler is, so both reach Next the same way; the
// eval compares them byte for byte.
async function missing(): Promise<never> {
  notFound();
}

export const dynamic = "force-dynamic";
export const GET = missing;
export const HEAD = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
export const OPTIONS = missing;
