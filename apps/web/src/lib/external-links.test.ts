import { strict as assert } from "node:assert";
import { test } from "node:test";

import { externalUrl } from "./external-links";

const PAGE = "http://127.0.0.1:3030/bots/abc";

test("a link a bot wrote opens outside the app", () => {
  // The case this was built for: Markdown in a reply, rendered with
  // target="_blank", which the desktop webview answers with nothing.
  assert.equal(
    externalUrl(
      { href: "https://www.mercadolibre.com.co/p/MCO2067359451", target: "_blank" },
      PAGE,
    ),
    "https://www.mercadolibre.com.co/p/MCO2067359451",
  );
});

test("another origin goes out even without target", () => {
  assert.equal(
    externalUrl({ href: "https://github.com/ideascol/nexux/releases" }, PAGE),
    "https://github.com/ideascol/nexux/releases",
  );
  // A sandbox preview is this host on another port — another origin.
  assert.equal(
    externalUrl({ href: "http://127.0.0.1:5173/" }, PAGE),
    "http://127.0.0.1:5173/",
  );
});

test("the app's own pages stay in the app", () => {
  assert.equal(externalUrl({ href: "/projects" }, PAGE), null);
  assert.equal(externalUrl({ href: "http://127.0.0.1:3030/settings" }, PAGE), null);
  assert.equal(externalUrl({ href: "#top" }, PAGE), null);
});

test("a page of ours sent to a new window still opens outside", () => {
  assert.equal(
    externalUrl({ href: "/api/bots/abc/files/report.pdf", target: "_blank" }, PAGE),
    "http://127.0.0.1:3030/api/bots/abc/files/report.pdf",
  );
});

test("mailto and tel are handed to the OS, other schemes are left alone", () => {
  assert.equal(externalUrl({ href: "mailto:a@b.co" }, PAGE), "mailto:a@b.co");
  assert.equal(externalUrl({ href: "tel:+573001112233" }, PAGE), "tel:+573001112233");
  // The opener's scope would refuse these anyway; the page keeps them.
  assert.equal(externalUrl({ href: "blob:http://127.0.0.1:3030/x", target: "_blank" }, PAGE), null);
  assert.equal(externalUrl({ href: "javascript:alert(1)", target: "_blank" }, PAGE), null);
  assert.equal(externalUrl({ href: "data:text/html,hi", target: "_blank" }, PAGE), null);
});

test("nothing to open is not an error", () => {
  assert.equal(externalUrl({ href: null }, PAGE), null);
  assert.equal(externalUrl({ href: "" }, PAGE), null);
  assert.equal(externalUrl({ href: "ht tp://nope" }, PAGE), null);
});
