import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above every other import (throwaway DB and data dir).
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { POST as upload } from "./bots/[botId]/uploads/route";
import { GET as getFile } from "./bots/[botId]/files/[runId]/[name]/route";
import { splitAttachments } from "@/lib/bot-attachments";

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const form = (file: File | null) => {
  const f = new FormData();
  if (file) f.append("file", file);
  return new NextRequest("http://localhost/x", { method: "POST", body: f });
};
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

test("an upload is stored and served back, under a safe name", async () => {
  const bot = await prisma.bot.create({ data: { name: "Isa" } });
  const res = await upload(form(new File(["hola"], "Notas año.txt", { type: "text/plain" })), params({ botId: bot.id }));
  assert.equal(res.status, 201);
  const body = (await res.json()) as { url: string; name: string; size: number };
  assert.equal(body.name, "Notas ano.txt");
  assert.equal(body.size, 4);
  const [att] = splitAttachments(`[${body.name}](${body.url})`).attachments;
  assert.ok(att);
  const served = await getFile(new NextRequest(`http://localhost${body.url}`), params({ botId: bot.id, runId: att.uploadId, name: encodeURIComponent(att.name) }));
  assert.equal(served.status, 200);
  assert.equal(await served.text(), "hola");
});

test("uploads: no file, an empty one, or an unknown bot are refused", async () => {
  const bot = await prisma.bot.create({ data: { name: "Luz" } });
  assert.equal((await upload(form(null), params({ botId: bot.id }))).status, 400);
  assert.equal((await upload(form(new File([], "a.txt")), params({ botId: bot.id }))).status, 400);
  assert.equal((await upload(form(new File(["x"], "a.txt")), params({ botId: "nope" }))).status, 404);
});
