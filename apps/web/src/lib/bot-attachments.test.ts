import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachmentMarkdown,
  attachmentPath,
  safeUploadName,
  splitAttachments,
  withDeliveredAttachments,
} from "./bot-attachments";

test("upload names: safe in a URL, a link and a path, extension kept", () => {
  assert.equal(safeUploadName("Contrato Año 2026.PDF"), "Contrato Ano 2026.pdf");
  assert.equal(safeUploadName("../../etc/passwd"), "passwd");
  assert.equal(safeUploadName("C:\\Users\\me\\foto (1).png"), "foto -1.png");
  assert.equal(safeUploadName(".env"), "env"); // never a hidden file
  assert.equal(safeUploadName("[x](evil).png"), "x-evil.png");
  assert.equal(safeUploadName(""), "file");
});

test("attachments ride as links and split back out; other links stay in the text", () => {
  const img = attachmentMarkdown({ name: "shot.png", url: "/api/bots/b1/files/up-abc1/shot.png" });
  const doc = attachmentMarkdown({ name: "Informe final.pdf", url: "/api/bots/b1/files/up-def2/Informe%20final.pdf" });
  assert.equal(img, "![shot.png](/api/bots/b1/files/up-abc1/shot.png)");
  assert.equal(doc, "[Informe final.pdf](/api/bots/b1/files/up-def2/Informe%20final.pdf)");
  const prompt = `Revisa esto y [la web](https://x.com)\n\n${img}\n${doc}`;
  const { text, attachments } = splitAttachments(prompt);
  assert.equal(text, "Revisa esto y [la web](https://x.com)");
  assert.deepEqual(
    attachments.map((a) => [a.name, a.image, a.uploadId]),
    [["shot.png", true, "up-abc1"], ["Informe final.pdf", false, "up-def2"]],
  );
  // A file a bot handed over (a run id, not an upload) is not an attachment.
  assert.equal(splitAttachments("![x](/api/bots/b1/files/run123/x.png)").attachments.length, 0);
  assert.equal(splitAttachments(img).text, "");
});

test("the bot reads paths in its computer; a file not delivered keeps its link", () => {
  const taken = new Set<string>();
  const a = attachmentPath("/workspace/isa", { name: "shot.png", uploadId: "up-abc123" }, taken);
  const b = attachmentPath("/workspace/isa", { name: "shot.png", uploadId: "up-zzz999" }, taken);
  assert.equal(a, "/workspace/isa/attachments/shot.png");
  assert.equal(b, "/workspace/isa/attachments/zzz999-shot.png");

  const prompt = "Mira\n\n![shot.png](/api/bots/b1/files/up-abc1/shot.png)\n[doc.pdf](/api/bots/b1/files/up-d/doc.pdf)";
  const out = withDeliveredAttachments(prompt, new Map([["/api/bots/b1/files/up-abc1/shot.png", a]]));
  assert.match(out, /\[attached: \/workspace\/isa\/attachments\/shot\.png\]/);
  assert.match(out, /\[doc\.pdf\]\(\/api\/bots\/b1\/files\/up-d\/doc\.pdf\)/);
  assert.match(out, /Read tool/);
  assert.equal(withDeliveredAttachments(prompt, new Map()), prompt);
});
