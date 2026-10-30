import { json } from "@unprompted-tables/server";
import { route } from "@/lib/http";
import { lobby } from "@/lib/queue";

export const GET = route(async () => json({ lobby: await lobby() }));
