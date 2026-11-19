import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { channelOf, composeImageSwapScript, withChannel } from "./host-channel";

test("the channel is read off the tag", () => {
  assert.equal(channelOf("ghcr.io/ideascoldigital/nexus:edge"), "edge");
  assert.equal(channelOf("ghcr.io/ideascoldigital/nexus:latest"), "latest");
  assert.equal(channelOf("ghcr.io/ideascoldigital/nexus"), "latest", "no tag is latest");
  assert.equal(channelOf("ghcr.io/ideascoldigital/nexus:0.3.0"), null, "a pinned version is custom");
});

test("a registry port is not mistaken for a tag", () => {
  assert.equal(channelOf("registry.local:5000/nexus"), "latest");
  assert.equal(withChannel("registry.local:5000/nexus", "edge"), "registry.local:5000/nexus:edge");
});

test("switching keeps the repository and drops a digest pin", () => {
  assert.equal(withChannel("ghcr.io/ideascoldigital/nexus:edge", "latest"), "ghcr.io/ideascoldigital/nexus:latest");
  assert.equal(withChannel("ghcr.io/o/nexus:0.3.0@sha256:abc123", "edge"), "ghcr.io/o/nexus:edge");
});

// Run for real: the script is shell, and only a shell says whether it works.

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const COMPOSE = `services:
  nexux:
    image: ghcr.io/o/nexus:edge
    restart: unless-stopped
  ollama:
    image: ollama/ollama:latest
`;

function runSwap(then: string, from = "ghcr.io/o/nexus:edge") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-"));
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), COMPOSE);
  let code = 0;
  try {
    execFileSync("bash", ["-c", composeImageSwapScript(from, "ghcr.io/o/nexus:latest", then, shq)], { cwd: dir });
  } catch {
    code = 1;
  }
  return { code, file: fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf8") };
}

test("the app image line is repointed, indentation and other services kept", () => {
  const { code, file } = runSwap("true");
  assert.equal(code, 0);
  assert.equal(file, COMPOSE.replace("nexus:edge", "nexus:latest"));
});

test("a failed pull puts the file back", () => {
  const { code, file } = runSwap("false");
  assert.equal(code, 1);
  assert.equal(file, COMPOSE);
});

test("an image line that is not the recorded one is left alone, and the switch fails", () => {
  const { code, file } = runSwap("true", "ghcr.io/o/nexus:0.1.0");
  assert.equal(code, 1);
  assert.equal(file, COMPOSE);
});
