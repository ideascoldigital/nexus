import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  removeSandboxSshHost,
  sandboxSshConfigPath,
  upsertSandboxSshHost,
  vsCodeRemoteUri,
} from "./ssh-config";

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexux-sshconf-"));
}

test("upsert writes a host block with key auth", () => {
  const dataDir = tmpDataDir();
  const alias = upsertSandboxSshHost({
    dataDir,
    name: "nexux-demo-abc123",
    host: "203.0.113.10",
    user: "nexux",
  });
  assert.equal(alias, "nexux-demo-abc123");
  const config = fs.readFileSync(sandboxSshConfigPath(dataDir), "utf8");
  assert.ok(config.includes("Host nexux-demo-abc123"));
  assert.ok(config.includes("HostName 203.0.113.10"));
  assert.ok(config.includes("User nexux"));
  assert.ok(config.includes(`IdentityFile ${path.join(dataDir, "ssh", "id_ed25519")}`));
  assert.ok(config.includes("StrictHostKeyChecking accept-new"));
});

test("upsert is idempotent and refreshes the IP", () => {
  const dataDir = tmpDataDir();
  const opts = { dataDir, name: "nexux-demo-abc123", user: "nexux" };
  upsertSandboxSshHost({ ...opts, host: "203.0.113.10" });
  upsertSandboxSshHost({ ...opts, host: "198.51.100.7" });
  const config = fs.readFileSync(sandboxSshConfigPath(dataDir), "utf8");
  assert.equal(config.match(/Host nexux-demo-abc123\n/g)?.length, 1);
  assert.ok(config.includes("HostName 198.51.100.7"));
  assert.ok(!config.includes("203.0.113.10"));
});

test("remove drops only the matching block", () => {
  const dataDir = tmpDataDir();
  upsertSandboxSshHost({
    dataDir,
    name: "nexux-a-111111",
    host: "203.0.113.1",
    user: "nexux",
  });
  upsertSandboxSshHost({
    dataDir,
    name: "nexux-b-222222",
    host: "203.0.113.2",
    user: "nexux",
  });
  removeSandboxSshHost(dataDir, "nexux-a-111111");
  const config = fs.readFileSync(sandboxSshConfigPath(dataDir), "utf8");
  assert.ok(!config.includes("nexux-a-111111"));
  assert.ok(config.includes("Host nexux-b-222222"));
});

test("remove tolerates a missing config file", () => {
  removeSandboxSshHost(tmpDataDir(), "nexux-none-000000");
});

test("vsCodeRemoteUri builds a Remote-SSH deep link", () => {
  assert.equal(
    vsCodeRemoteUri("nexux-demo-abc123", "/opt/nexus/app"),
    "vscode://vscode-remote/ssh-remote+nexux-demo-abc123/opt/nexus/app",
  );
  // Missing leading slash is normalized.
  assert.equal(
    vsCodeRemoteUri("h", "opt/nexus"),
    "vscode://vscode-remote/ssh-remote+h/opt/nexus",
  );
});
