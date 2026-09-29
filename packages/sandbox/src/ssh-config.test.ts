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

// --- Docker endpoints from a Nexus host (spec 27 phase 6) ---------------------

import { execFileSync } from "node:child_process";
import { endpointSshHostname, removeEndpointSshHost, upsertEndpointSshHost } from "./ssh-config";
import { endpointPrivateKeyPath, ensureEndpointKeypair, sandboxPrivateKeyPath as sandboxKey } from "./keys";

test("the address ssh is asked for is read out of the docker host", () => {
  assert.equal(endpointSshHostname("ssh://dev@192.168.1.35"), "192.168.1.35");
  assert.equal(endpointSshHostname("ssh://devbox.lan:2222"), "devbox.lan");
  assert.equal(endpointSshHostname("ssh://u@[fd00::1]:22"), "fd00::1");
  assert.equal(endpointSshHostname("tcp://1.2.3.4:2375"), null);
});

test("an endpoint block points ssh at the endpoint key, and is replaced, not stacked", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-"));
  upsertEndpointSshHost(dataDir, "ssh://dev@192.168.1.35");
  upsertEndpointSshHost(dataDir, "ssh://dev@192.168.1.35");
  upsertEndpointSshHost(dataDir, "ssh://other@10.0.0.9");
  const config = fs.readFileSync(path.join(dataDir, "ssh", "config"), "utf8");
  assert.equal(config.match(/^Host 192\.168\.1\.35$/gm)?.length, 1);
  assert.match(config, new RegExp(`IdentityFile ${endpointPrivateKeyPath(dataDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(config, /StrictHostKeyChecking accept-new/);
  // ssh itself resolves it that way (no connection is made by -G).
  const resolved = execFileSync("ssh", ["-G", "-F", path.join(dataDir, "ssh", "config"), "dev@192.168.1.35"]).toString();
  assert.match(resolved, new RegExp(`^identityfile ${endpointPrivateKeyPath(dataDir)}$`, "m"));
  assert.match(resolved, /^user dev$/m, "the user from the URL wins");
  removeEndpointSshHost(dataDir, "ssh://dev@192.168.1.35");
  const after = fs.readFileSync(path.join(dataDir, "ssh", "config"), "utf8");
  assert.doesNotMatch(after, /192\.168\.1\.35/);
  assert.match(after, /^Host 10\.0\.0\.9$/m, "other endpoints stay");
});

test("the endpoint key is its own, and names the host in its comment", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "epk-"));
  const key = ensureEndpointKeypair(dataDir, "nexus-host-nexus-e2e");
  assert.equal(key.privateKeyPath, endpointPrivateKeyPath(dataDir));
  assert.notEqual(key.privateKeyPath, sandboxKey(dataDir));
  assert.match(key.publicKey, /^ssh-ed25519 \S+ nexus-host-nexus-e2e$/);
  assert.equal(ensureEndpointKeypair(dataDir, "ignored").publicKey, key.publicKey, "made once, kept");
});
