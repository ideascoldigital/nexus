import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import "../app/api/routes.test-setup";
import { botFilesDir } from "@/lib/bot-files";

import { nexusMessage } from "./nexus-attachments";

function upload(botId: string, id: string, name: string, bytes: Buffer | string) {
  const dir = botFilesDir(botId, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  return `/api/bots/${botId}/files/${id}/${name}`;
}

test("a plain message stays a plain prompt", () => {
  assert.deepEqual(nexusMessage("b1", "hola"), { text: "hola", blocks: null });
});

test("images ride as image blocks, text files inline, other files are named", () => {
  const img = upload("b2", "up-1", "shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const txt = upload("b2", "up-2", "notes.md", "# Plan\nship it");
  const zip = upload("b2", "up-3", "repo.zip", "PK");
  const msg = nexusMessage("b2", `mira esto\n\n![shot.png](${img})\n[notes.md](${txt})\n[repo.zip](${zip})`);
  assert.equal(msg.blocks?.[0]?.type, "text");
  assert.equal(msg.blocks?.[1]?.type, "image");
  assert.match(msg.text, /mira esto/);
  assert.match(msg.text, /Attached file "notes.md":\n```\n# Plan\nship it/);
  assert.match(msg.text, /"repo.zip" — a file you cannot open here/);
});

test("another bot's files are not read", () => {
  const theirs = upload("other", "up-9", "secret.md", "x");
  assert.deepEqual(nexusMessage("b3", `[secret.md](${theirs})`).blocks, null);
});
