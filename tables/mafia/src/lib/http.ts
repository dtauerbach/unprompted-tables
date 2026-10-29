import { ApiError, route as sharedRoute } from "@unprompted-tables/server";

// SQL errors can include bound private events in their parameters. Preserve
// intentional API refusals, but never pass raw exceptions to the shared logger.
export function route<C>(handler: (req: Request, ctx: C) => Promise<Response>) {
  return sharedRoute(async (req: Request, ctx: C) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error("Mafia request failed.");
    }
  });
}
