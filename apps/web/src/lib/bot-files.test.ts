import assert from "node:assert/strict";
import { test } from "node:test";

import { contentTypeFor, findOutboxRefs, outboxName, rewriteOutboxRefs } from "./bot-files";

test("outbox references: names inside the outbox only, no traversal", () => {
  assert.equal(outboxName("outbox://slide-1.png"), "slide-1.png");
  assert.equal(outboxName("outbox://Informe%20final.pdf"), "Informe final.pdf");
  assert.equal(outboxName("/home/bot/outbox/carrusel_es_1.png"), "carrusel_es_1.png");
  assert.equal(outboxName("file:///home/bot/outbox/a.svg"), "a.svg");
  assert.equal(outboxName("outbox://../etc/passwd"), null);
  assert.equal(outboxName("outbox://sub/dir.png"), null);
  assert.equal(outboxName("outbox://.hidden"), null);
  assert.equal(outboxName("/home/bot/work/a.png"), null);
  assert.equal(outboxName("https://example.com/a.png"), null);
});

test("refs are found in images and links, deduped", () => {
  const text = [
    "Aquí están:",
    "![Portada](outbox://slide-1.png)",
    "![Portada otra vez](outbox://slide-1.png)",
    '[El PDF](</home/bot/outbox/deck.pdf> "titulo")',
    "[web](https://example.com) y http://localhost:8765/x.png",
  ].join("\n");
  assert.deepEqual(findOutboxRefs(text), [
    { url: "outbox://slide-1.png", name: "slide-1.png" },
    { url: "/home/bot/outbox/deck.pdf", name: "deck.pdf" },
  ]);
});

test("refs are rewritten to Nexus URLs, or marked missing", () => {
  const done = new Map<string, string | null>([
    ["outbox://a.png", "/api/bots/b1/files/r1/a.png"],
    ["outbox://gone.png", null],
  ]);
  assert.equal(
    rewriteOutboxRefs("![A](outbox://a.png) ![B](outbox://gone.png) [x](https://e.com)", done),
    "![A](/api/bots/b1/files/r1/a.png) ![B](#missing-file) [x](https://e.com)",
  );
});

test("content types: images and documents known, html never served as html", () => {
  assert.equal(contentTypeFor("a.PNG"), "image/png");
  assert.equal(contentTypeFor("a.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("a.pdf"), "application/pdf");
  assert.match(contentTypeFor("page.html"), /^text\/plain/);
  assert.equal(contentTypeFor("blob.bin"), "application/octet-stream");
});
