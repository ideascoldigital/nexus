import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownReport } from "./markdown-report";

// Agents write GitHub-flavoured markdown, not the CommonMark subset. Without
// remark-gfm a bare merge-request URL renders as dead text and a comparison
// table as rows of pipes — both parser features, so nothing about the styling
// hints that they are missing. These fail if the plugin is ever dropped.
//
// `.test.ts`, not `.test.tsx`: the suite glob only matches `.ts`, so a `.tsx`
// file would silently never run. Hence createElement instead of JSX.

const render = (markdown: string) =>
  renderToStaticMarkup(createElement(MarkdownReport, null, markdown));

const MR = "https://git.example.com/acme/group/acme-api/-/merge_requests/254";

test("a bare URL becomes a link", () => {
  // The single most useful thing an agent report contains.
  const html = render(`Abrí la MR: ${MR}`);
  assert.match(html, new RegExp(`<a href="${MR.replace(/[/-]/g, "\\$&")}"`));
});

test("links open in a new tab and cannot reach the opener", () => {
  const html = render(`See ${MR}`);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
});

test("a long URL is allowed to break", () => {
  // One unbroken token wide enough to put the whole panel into a horizontal
  // scroll otherwise.
  assert.match(render(`See ${MR}`), /class="[^"]*break-all/);
});

test("an explicit markdown link still works", () => {
  const html = render(`[la MR](${MR})`);
  assert.match(html, /<a href="https:\/\/git\.example\.com/);
  assert.match(html, />la MR</);
});

test("a table renders as a table, not as pipes", () => {
  const html = render(
    ["| Campo | Estado |", "| --- | --- |", "| pods | sin fuente |"].join("\n"),
  );
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>Campo<\/th>/);
  assert.match(html, /<td[^>]*>sin fuente<\/td>/);
  assert.doesNotMatch(html, /\| Campo \|/, "no raw pipes left over");
});

test("a wide table scrolls itself instead of the page", () => {
  // A wide table in a narrow side panel is normal in these reports; letting it
  // widen the container breaks every sibling.
  assert.match(render("| a | b |\n| --- | --- |\n| 1 | 2 |"), /overflow-x-auto/);
});

test("task lists render as read-only checkboxes", () => {
  // A report is a record of what happened, not a checklist to tick.
  const html = render("- [x] tests\n- [ ] docs");
  assert.match(html, /type="checkbox"/);
  assert.match(html, /readonly/i);
});

test("strikethrough renders", () => {
  assert.match(render("~~texto viejo~~"), /<del/);
});

test("headings, code and lists still render after enabling gfm", () => {
  // The plugin changes the parser, so the plain-markdown path is worth
  // re-checking rather than assumed.
  const html = render("# T\n\nsome `inline` code\n\n- one\n- two");
  assert.match(html, /<h1/);
  assert.match(html, /<code/);
  assert.match(html, /<li/);
});

test("empty input renders nothing rather than throwing", () => {
  assert.doesNotThrow(() => render(""));
});

test("consecutive images form one row; mixed paragraphs do not", async () => {
  const { isImageRow, joinImageLines } = await import("./markdown-report");
  const img = { type: "element", tagName: "img" };
  const nl = { type: "text", value: "\n" };
  assert.equal(isImageRow({ type: "element", children: [img, nl, img] }), true);
  assert.equal(isImageRow({ type: "element", children: [img] }), false);
  assert.equal(isImageRow({ type: "element", children: [img, { type: "text", value: " Portada" }, img] }), false);
  assert.equal(joinImageLines("![a](1.png)\n\n![b](2.png)\n\n\n![c](3.png)\n\nTexto"), "![a](1.png)\n![b](2.png)\n![c](3.png)\n\nTexto");
  assert.equal(joinImageLines("Hola\n\n![a](1.png)"), "Hola\n\n![a](1.png)");
});
