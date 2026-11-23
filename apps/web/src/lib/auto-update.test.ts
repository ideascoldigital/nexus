import assert from "node:assert/strict";
import { test } from "node:test";

import "@/app/api/routes.test-setup";

import { autoUpdateDisabledReason, canRelaunch, shouldInstall } from "./auto-update";

const NATIVE_RELEASE = { NEXUX_NATIVE: "1", NEXUX_RELEASE_BUILD: "1" };

test("only a native release build updates itself in the background", () => {
  assert.equal(autoUpdateDisabledReason(NATIVE_RELEASE), null);
  assert.match(autoUpdateDisabledReason({}) ?? "", /not the native app/);
  assert.match(
    autoUpdateDisabledReason({ NEXUX_RELEASE_BUILD: "1" }) ?? "",
    /not the native app/,
    "a Docker host or dev server never installs a desktop bundle",
  );
});

test("a local build never auto-installs over itself", () => {
  // `pnpm build:native` from a checkout reports package.json's version, which
  // lags the tags — left on, it would replace the build just made with an
  // older published release.
  assert.match(autoUpdateDisabledReason({ NEXUX_NATIVE: "1" }) ?? "", /local build/);
});

test("NEXUX_AUTO_UPDATE=0 turns it off even on a release build", () => {
  assert.match(
    autoUpdateDisabledReason({ ...NATIVE_RELEASE, NEXUX_AUTO_UPDATE: "0" }) ?? "",
    /turned off/,
  );
});

test("installs only a release newer than the running build", () => {
  assert.equal(shouldInstall("0.3.5", "v0.3.6", { phase: "idle" }), true);
  assert.equal(shouldInstall("0.3.6", "v0.3.6", { phase: "idle" }), false, "already on it");
  assert.equal(shouldInstall("0.3.7", "v0.3.6", { phase: "idle" }), false, "ahead of it");
});

test("does not reinstall a release that is only waiting for a restart", () => {
  const waiting = { phase: "installed" as const, tag: "v0.3.6" };
  assert.equal(shouldInstall("0.3.5", "v0.3.6", waiting), false, "every 6h check would redownload it");
  assert.equal(shouldInstall("0.3.5", "v0.3.7", waiting), true, "a newer one supersedes it");
});

test("restart is offered where the app can be relaunched", () => {
  assert.equal(canRelaunch("darwin"), true);
  assert.equal(canRelaunch("linux"), true);
  assert.equal(canRelaunch("win32"), false, "the NSIS installer relaunches it itself");
});
