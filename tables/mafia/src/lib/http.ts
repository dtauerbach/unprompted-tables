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
