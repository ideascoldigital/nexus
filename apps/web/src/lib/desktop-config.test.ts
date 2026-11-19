import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

// Only read, never opened: databasePath() just resolves the URL.
process.env.DATABASE_URL ??= "file:/tmp/nexux-desktop-config-test.db";


import {
  desktopConfigPath,
  readDesktopConfig,
  resolveDesktopConfig,
  writeDesktopConfig,
} from "./desktop-config";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-home-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

test("no file means the default layout under ~/.nexux", () => {
  const view = readDesktopConfig(home);
  assert.equal(view.file, null);
  assert.equal(view.fileError, null);
  assert.equal(view.effective?.databasePath, path.join(home, ".nexux", "nexux.db"));
  assert.equal(view.effective?.dataDir, path.join(home, ".nexux"));
});

test("a database path is saved as typed and resolved with ~ expanded", () => {
  assert.deepEqual(writeDesktopConfig({ databasePath: "~/ws/dashboard.db" }, home), { ok: true });
  const saved = JSON.parse(fs.readFileSync(desktopConfigPath(home), "utf8"));
  assert.deepEqual(saved, { databasePath: "~/ws/dashboard.db" });
  const view = readDesktopConfig(home);
  assert.equal(view.effective?.databasePath, path.join(home, "ws/dashboard.db"));
  assert.equal(view.effective?.databaseExists, false);
});

test("clearing every override removes the file instead of writing an empty one", () => {
  writeDesktopConfig({ databasePath: "/x/y.db" }, home);
  writeDesktopConfig({ databasePath: "  ", dataDir: "" }, home);
  assert.equal(fs.existsSync(desktopConfigPath(home)), false);
});

test("the same things the desktop shell refuses are refused before writing", () => {
  assert.match(
    (writeDesktopConfig({ databasePath: "data/dashboard.db" }, home) as { error: string }).error,
    /absolute path/,
  );
  assert.match(
    (writeDesktopConfig({ databasePath: home }, home) as { error: string }).error,
    /is a directory/,
  );
  assert.equal(fs.existsSync(desktopConfigPath(home)), false);
  assert.match(
    (resolveDesktopConfig({ databasePth: "/x.db" }, home) as { error: string }).error,
    /Unknown key: databasePth/,
  );
});

test("a hand-edited file the app would refuse is reported, not trusted", () => {
  fs.mkdirSync(path.join(home, ".nexux"), { recursive: true });
  fs.writeFileSync(desktopConfigPath(home), "{ nope");
  const view = readDesktopConfig(home);
  assert.match(view.fileError ?? "", /not valid JSON/);
  assert.equal(view.effective, null);
});
