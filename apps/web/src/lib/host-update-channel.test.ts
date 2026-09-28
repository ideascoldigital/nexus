import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import "../app/api/routes.test-setup";
import { requestSelfUpdate, selfImage } from "./host-update";

const saved = { ...process.env };
afterEach(() => {
  process.env.NEXUX_IMAGE = saved.NEXUX_IMAGE;
  if (saved.NEXUX_IMAGE === undefined) delete process.env.NEXUX_IMAGE;
});

test("a host reads its channel off its own image", () => {
  process.env.NEXUX_IMAGE = "ghcr.io/o/nexus:edge";
  assert.deepEqual(selfImage(), { image: "ghcr.io/o/nexus:edge", channel: "edge" });
  process.env.NEXUX_IMAGE = "ghcr.io/o/nexus:0.3.2";
  assert.equal(selfImage().channel, null, "a pinned version is no channel");
  delete process.env.NEXUX_IMAGE;
  assert.deepEqual(selfImage(), { image: null, channel: null });
});

test("a host that predates NEXUX_IMAGE refuses a switch rather than updating on its old tag", async () => {
  delete process.env.NEXUX_IMAGE;
  const res = await requestSelfUpdate("edge");
  assert.equal(res.ok, false);
  assert.match(res.message, /Update it once from the install that created it/);
});
