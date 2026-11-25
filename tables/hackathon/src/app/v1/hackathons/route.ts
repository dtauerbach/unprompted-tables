import { json, route } from "@unprompted-tables/server";
import { listHackathons } from "@/lib/store";

export const GET = route(async () =>
  json({ hackathons: await listHackathons() }),
);
