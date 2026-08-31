import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { prepareWorkDir } from "./provisioner";
import type { SandboxSpec } from "./types";

function baseSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    provider: "civo",
    name: "nexux-test-abc123",
    region: "NYC1",
    size: "g3.medium",
    diskImage: "ubuntu-jammy",
    installDocker: true,
    installNode: true,
    installClaudeCode: true,
    installAgentBrowser: false,
    installCloudflared: false,
    envVars: {},
    repos: [{ name: "app", repoUrl: "https://github.com/acme/app.git" }],
    ...overrides,
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nexux-workdir-"));
}

// --- EC2 user_data: gzipped, because the plain bootstrap exceeds 16 KB ------

test("aws writes a gzipped bootstrap that round-trips to the plain one", () => {
  const workDir = tmpDir();
  prepareWorkDir(workDir, baseSpec({ provider: "aws" }));

  const plain = fs.readFileSync(path.join(workDir, "cloud-init.sh"), "utf8");
  const gz = fs.readFileSync(path.join(workDir, "cloud-init.sh.gz"));
  assert.equal(gunzipSync(gz).toString("utf8"), plain);
  // The whole point: the compressed form fits where the plain one may not.
  assert.ok(gz.byteLength <= 16 * 1024);
  // And the terraform module actually sends the gzipped file.
  const mainTf = fs.readFileSync(path.join(workDir, "main.tf"), "utf8");
  assert.ok(mainTf.includes('filebase64("${path.module}/cloud-init.sh.gz")'));
  assert.ok(!/user_data\s+=/.test(mainTf), "plain user_data must be gone");
});

test("a bootstrap that outgrows 16 KB even gzipped still fails fast", () => {
  // Incompressible payload: random bytes survive gzip nearly unshrunk, so
  // this models a config genuinely too big rather than merely verbose.
  const spec = baseSpec({
    provider: "aws",
    setupScript: `# ${randomBytes(64 * 1024).toString("base64")}`,
  });
  assert.throws(() => prepareWorkDir(tmpDir(), spec), /gzipped .* 16 KB/);
});

test("a verbose-but-compressible bootstrap now fits on aws", () => {
  // ~36 KB of shell (the real-world failure) compresses well under the cap.
  const spec = baseSpec({
    provider: "aws",
    installAgentBrowser: true,
    installCloudflared: true,
    setupScript: 'echo "extra setup step"\n'.repeat(400),
  });
  const workDir = tmpDir();
  prepareWorkDir(workDir, spec);
  const plain = fs.readFileSync(path.join(workDir, "cloud-init.sh"), "utf8");
  assert.ok(Buffer.byteLength(plain, "utf8") > 16 * 1024, "test premise: plain form is over the cap");
  assert.ok(fs.statSync(path.join(workDir, "cloud-init.sh.gz")).size <= 16 * 1024);
});

test("civo keeps the plain script and writes no gzip", () => {
  const workDir = tmpDir();
  prepareWorkDir(workDir, baseSpec());
  assert.ok(fs.existsSync(path.join(workDir, "cloud-init.sh")));
  assert.ok(!fs.existsSync(path.join(workDir, "cloud-init.sh.gz")));
  const mainTf = fs.readFileSync(path.join(workDir, "main.tf"), "utf8");
  assert.ok(mainTf.includes('file("${path.module}/cloud-init.sh")'));
});
