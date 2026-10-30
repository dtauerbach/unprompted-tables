import { json, route } from "@unprompted-tables/server";
import { lobby } from "@/lib/queue";

export const GET = route(async () => json({ lobby: await lobby() }));
