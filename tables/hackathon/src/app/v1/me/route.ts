import { json, route } from "@unprompted-tables/server";
import { authenticate } from "@/lib/sessions";

export const GET = route(async (req) => json({ bot: await authenticate(req) }));
