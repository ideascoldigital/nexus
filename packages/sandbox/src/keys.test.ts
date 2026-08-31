import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
  ensureSandboxKeypair,
  sandboxKeyDir,
  sandboxPrivateKeyPath,
} from "./keys";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-keys-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("path helpers derive from dataDir", () => {
  assert.equal(sandboxKeyDir("/data"), path.join("/data", "ssh"));
  assert.equal(
    sandboxPrivateKeyPath("/data"),
    path.join("/data", "ssh", "id_ed25519"),
  );
});

test("ensureSandboxKeypair generates an ed25519 keypair", () => {
  const kp = ensureSandboxKeypair(dataDir);
  assert.equal(kp.privateKeyPath, sandboxPrivateKeyPath(dataDir));
  assert.ok(fs.existsSync(kp.privateKeyPath));
  assert.ok(fs.existsSync(`${kp.privateKeyPath}.pub`));
  assert.match(kp.publicKey, /^ssh-ed25519 /);
});

test("ensureSandboxKeypair is idempotent", () => {
  const first = ensureSandboxKeypair(dataDir);
  const privBefore = fs.readFileSync(first.privateKeyPath, "utf8");
  const second = ensureSandboxKeypair(dataDir);
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(fs.readFileSync(second.privateKeyPath, "utf8"), privBefore);
});

test("ensureSandboxKeypair re-derives a missing public key", () => {
  const first = ensureSandboxKeypair(dataDir);
  fs.rmSync(`${first.privateKeyPath}.pub`);
  const second = ensureSandboxKeypair(dataDir);
  assert.equal(second.publicKey, first.publicKey);
  assert.ok(fs.existsSync(`${first.privateKeyPath}.pub`));
});
