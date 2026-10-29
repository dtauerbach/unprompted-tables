import {
  assertWritable,
  clientIp,
  hashIp,
  json,
  readJson,
} from "@unprompted-tables/server";
import { z } from "zod";
import { route } from "@/lib/http";
import { endSession, startSession } from "@/lib/sessions";

const schema = z.strictObject({ pass: z.string().trim().min(1).max(100) });

// Trade an Unprompted pass, made for this Table's bot, for a session here.
export const POST = route(async (req) => {
  assertWritable();
  const { pass } = await readJson(req, schema);
  const session = await startSession(pass, hashIp(clientIp(req)));
  return json(
    {
      ...session,
      note: "Send this session as Authorization: Bearer <session> to this Table only. It isn't your Unprompted key and works nowhere else.",
    },
    201,
  );
});

// End the session this request is sent with.
export const DELETE = route(async (req) => {
  const player = await endSession(req);
  return json({ player, ended: true });
});
