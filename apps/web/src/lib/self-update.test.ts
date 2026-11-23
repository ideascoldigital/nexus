import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { appImageDest, pickAsset, windowsInstallerCommand } from "./self-update";

// The exact asset list release-native.yml produced for v0.1.3 — the contract
// this picker exists to match.
const V013 = [
  "Nexux-0.1.3-1.x86_64.rpm",
  "Nexux_0.1.3_aarch64.dmg",
  "Nexux_0.1.3_amd64.AppImage",
  "Nexux_0.1.3_amd64.deb",
  "Nexux_0.1.3_x64-setup.exe",
  "Nexux_0.1.3_x64_en-US.msi",
  "Nexux_aarch64.app.tar.gz",
];

test("pickAsset matches every platform this release ships", () => {
  assert.equal(pickAsset(V013, "darwin", "arm64"), "Nexux_0.1.3_aarch64.dmg");
  assert.equal(pickAsset(V013, "win32", "x64"), "Nexux_0.1.3_x64-setup.exe");
  assert.equal(pickAsset(V013, "linux", "x64"), "Nexux_0.1.3_amd64.AppImage");
});

test("pickAsset returns null rather than guessing", () => {
  assert.equal(pickAsset(V013, "darwin", "x64"), null, "no x64 dmg shipped");
  assert.equal(pickAsset(V013, "linux", "arm64"), null, "no arm64 AppImage");
  assert.equal(pickAsset([], "darwin", "arm64"), null);
  assert.equal(pickAsset(V013, "freebsd", "x64"), null);
});

test("pickAsset falls back to the msi when no setup exe exists", () => {
  const noExe = V013.filter((n) => !n.endsWith("-setup.exe"));
  assert.equal(pickAsset(noExe, "win32", "x64"), "Nexux_0.1.3_x64_en-US.msi");
});

// The product rename (Nexux → Nexus) changes every asset's prefix; the picker
// matches on platform suffixes precisely so this keeps working.
const V018 = [
  "Nexus-0.1.8-1.x86_64.rpm",
  "Nexus_0.1.8_aarch64.dmg",
  "Nexus_0.1.8_amd64.AppImage",
  "Nexus_0.1.8_amd64.deb",
  "Nexus_0.1.8_x64-setup.exe",
  "Nexus_0.1.8_x64_en-US.msi",
  "Nexus_aarch64.app.tar.gz",
];

test("pickAsset matches the renamed assets too", () => {
  assert.equal(pickAsset(V018, "darwin", "arm64"), "Nexus_0.1.8_aarch64.dmg");
  assert.equal(pickAsset(V018, "win32", "x64"), "Nexus_0.1.8_x64-setup.exe");
  assert.equal(pickAsset(V018, "linux", "x64"), "Nexus_0.1.8_amd64.AppImage");
});

test("appImageDest keeps updating a legacy Nexux.AppImage in place", () => {
  const dir = "/home/dev/.local/bin";
  assert.equal(
    appImageDest(dir, ["Nexux.AppImage", "other"]),
    path.join(dir, "Nexux.AppImage"),
  );
  assert.equal(appImageDest(dir, []), path.join(dir, "Nexus.AppImage"));
  assert.equal(
    appImageDest(dir, ["Nexus.AppImage"]),
    path.join(dir, "Nexus.AppImage"),
  );
});

test("a Windows installer is launched directly, never through cmd.exe", () => {
  // `cmd /c start "" <file>` re-parses the path: an `&` in it ran a command.
  const exe = "C:\\Temp\\nexux-update-a&b\\Nexus_0.3.6_x64-setup.exe";
  assert.deepEqual(windowsInstallerCommand(exe), [exe]);
  const msi = "C:\\Temp\\Nexus_0.3.6_x64_en-US.MSI";
  assert.deepEqual(windowsInstallerCommand(msi), ["msiexec", "/i", msi]);
});
