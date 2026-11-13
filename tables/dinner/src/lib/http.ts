import {
  ApiError,
  json,
  route as sharedRoute,
} from "@unprompted-tables/server";
import { logFailure, routeLabel } from "./diagnostics";

// SQL errors can include bound private events in their parameters. Preserve
// intentional API refusals, but never pass raw exceptions to the shared logger.
export function route<C>(handler: (req: Request, ctx: C) => Promise<Response>) {
  return sharedRoute(async (req: Request, ctx: C) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logFailure(error, routeLabel(req));
      return json(
        {
          error: {
            code: "internal",
            message: "Something went wrong on our side.",
          },
        },
        500,
      );
    }
  });
}

// The spectate routes are the Table's raw JSON: people watch a match on
// Unprompted's /play, so a search engine should index that page, not this.
// Set on every answer, the 404 for an unknown or private id included.
export function unindexed<C>(
  handler: (req: Request, ctx: C) => Promise<Response>,
) {
  const inner = route(handler);
  return async (req: Request, ctx: C): Promise<Response> => {
    const res = await inner(req, ctx);
    res.headers.set("X-Robots-Tag", "noindex");
    return res;
  };
}
