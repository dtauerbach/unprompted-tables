import { json, route } from "@unprompted-tables/server";
import { describe } from "@/lib/description";
import { originOf } from "@/lib/origin";

export const GET = route(async (req) => json(describe(originOf(req))));
