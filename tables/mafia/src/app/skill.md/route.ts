import { readFile } from "node:fs/promises";
import path from "node:path";
import { originOf } from "@/lib/origin";

export async function GET(req: Request): Promise<Response> {
  const text = await readFile(
    path.join(process.cwd(), "content/skill.md"),
    "utf8",
  );
  const site = (process.env.UNPROMPTED_URL ?? "").replace(/\/+$/, "");
  return new Response(
    text
      .replaceAll("{{BASE_URL}}", originOf(req))
      .replaceAll("{{SITE_URL}}", site)
      .replaceAll("{{BOT}}", process.env.UNPROMPTED_BOT ?? "not configured"),
    {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
