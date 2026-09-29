import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";

import { clickUpCallbackUrl, publicOrigin } from "./public-origin";

// The bug this guards against: Next's standalone server builds request URLs
// from the address it bound to, so in the Docker image every route sees
// `http://0.0.0.0:3030` and any redirect_uri built from it points nowhere.

const saved = process.env.NEXUX_WEB_ORIGIN;

afterEach(() => {
  if (saved === undefined) delete process.env.NEXUX_WEB_ORIGIN;
  else process.env.NEXUX_WEB_ORIGIN = saved;
});

/** A request as the standalone server sees it: URL from HOSTNAME, not Host. */
const boundToAnyAddress = (headers: Record<string, string> = {}) =>
  new NextRequest("http://0.0.0.0:3030/api/clickup/oauth/start", { headers });

test("NEXUX_WEB_ORIGIN wins over the address the server bound to", () => {
  process.env.NEXUX_WEB_ORIGIN = "http://100.64.0.20:3030";
  assert.equal(publicOrigin(boundToAnyAddress()), "http://100.64.0.20:3030");
});

test("a trailing slash on NEXUX_WEB_ORIGIN does not double up in the callback", () => {
  process.env.NEXUX_WEB_ORIGIN = "https://nexus-host66.taild9d20a.ts.net/";
  assert.equal(
    clickUpCallbackUrl(boundToAnyAddress()),
    "https://nexus-host66.taild9d20a.ts.net/api/clickup/oauth/callback"
  );
});

test("without the env var, X-Forwarded-* from a reverse proxy is trusted", () => {
  delete process.env.NEXUX_WEB_ORIGIN;
  const req = boundToAnyAddress({
    host: "0.0.0.0:3030",
    "x-forwarded-host": "nexus-host66.taild9d20a.ts.net",
    "x-forwarded-proto": "https",
  });
  assert.equal(publicOrigin(req), "https://nexus-host66.taild9d20a.ts.net");
});

test("a comma-joined forwarded chain uses the client-facing hop", () => {
  delete process.env.NEXUX_WEB_ORIGIN;
  const req = boundToAnyAddress({
    "x-forwarded-host": "outer.ts.net, inner.internal",
    "x-forwarded-proto": "https, http",
  });
  assert.equal(publicOrigin(req), "https://outer.ts.net");
});

test("with only a Host header, the request's own protocol is kept", () => {
  delete process.env.NEXUX_WEB_ORIGIN;
  const req = boundToAnyAddress({ host: "100.64.0.20:3030" });
  assert.equal(publicOrigin(req), "http://100.64.0.20:3030");
});

test("with nothing to go on it falls back to Next's view — right in pnpm dev", () => {
  delete process.env.NEXUX_WEB_ORIGIN;
  const req = new NextRequest("http://localhost:3000/api/clickup/oauth/start");
  req.headers.delete("host");
  assert.equal(publicOrigin(req), "http://localhost:3000");
});
