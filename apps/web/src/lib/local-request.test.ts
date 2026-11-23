import assert from "node:assert/strict";
import { test } from "node:test";

import { hostnameOf, localRequestRejection } from "./local-request";

function post(headers: Record<string, string>, url = "http://127.0.0.1:3030/api/x"): Request {
  return new Request(url, { method: "POST", headers, body: "{}" });
}

const JSON_CT = { "content-type": "application/json" };

test("the app's own JSON request passes", () => {
  assert.equal(localRequestRejection(post({ ...JSON_CT, "sec-fetch-site": "same-origin" })), null);
  assert.equal(localRequestRejection(post({ "content-type": "application/json; charset=utf-8" })), null);
  assert.equal(localRequestRejection(post(JSON_CT, "http://localhost:3100/api/x")), null, "pnpm dev:native");
});

test("a request with no preflight is refused, whatever its content type says", () => {
  // These are CORS-safelisted, so another site's page can send them.
  for (const ct of ["text/plain", "text/plain; x=application/json", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    assert.match(localRequestRejection(post({ "content-type": ct })) ?? "", /JSON/, ct);
  }
  assert.match(localRequestRejection(post({})) ?? "", /JSON/, "no content type");
});

test("a cross-site request is refused", () => {
  for (const site of ["cross-site", "same-site"]) {
    assert.match(localRequestRejection(post({ ...JSON_CT, "sec-fetch-site": site })) ?? "", /cross-site/, site);
  }
});

test("a rebound hostname is refused even though it looks same-origin", () => {
  const rebound = post({ ...JSON_CT, "sec-fetch-site": "same-origin", host: "attacker.example:3030" });
  assert.match(localRequestRejection(rebound) ?? "", /this machine/);
  assert.match(localRequestRejection(post(JSON_CT, "http://127.0.0.1.attacker.example/x")) ?? "", /this machine/);
});

test("hostnameOf strips the port, IPv6 included", () => {
  assert.equal(hostnameOf("127.0.0.1:3030"), "127.0.0.1");
  assert.equal(hostnameOf("[::1]:3030"), "[::1]");
  assert.equal(hostnameOf("localhost"), "localhost");
});
