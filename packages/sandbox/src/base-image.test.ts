import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  baseImageIsCurrent,
  dryRunSpec,
  renderBaseDockerfile,
  BASE_IMAGE_FROM,
  BASE_IMAGE_TAG,
  BASE_IMAGE_VERSION,
  DRY_RUN_SKIPS,
} from "./base-image";
import { renderCloudInit, AGENT_USER } from "./template";
import type { SandboxSpec } from "./types";

function baseSpec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    provider: "local",
    name: "nexux-test",
    region: "NYC1",
    size: "g3.medium",
    diskImage: "ubuntu-jammy",
    installDocker: true,
    installNode: true,
    installClaudeCode: true,
    installAgentBrowser: true,
    installCloudflared: true,
    envVars: {},
    repos: [{ name: "app", repoUrl: "https://github.com/acme/app.git" }],
    ...over,
  } as SandboxSpec;
}

test("the tag carries the version, so a stale image cannot be reused silently", () => {
  assert.match(BASE_IMAGE_TAG, new RegExp(`:v${BASE_IMAGE_VERSION}$`));
});

test("the version label round-trips through the check", () => {
  assert.equal(baseImageIsCurrent(String(BASE_IMAGE_VERSION)), true);
  assert.equal(baseImageIsCurrent(` ${BASE_IMAGE_VERSION} `), true);
  // An older base answering for tooling that has since changed is the silent
  // wrong answer this whole spec exists to remove.
  assert.equal(baseImageIsCurrent(String(BASE_IMAGE_VERSION - 1)), false);
  assert.equal(baseImageIsCurrent(null), false);
  assert.equal(baseImageIsCurrent(undefined), false);
  assert.equal(baseImageIsCurrent("<no value>"), false);
});

test("the Dockerfile bakes the same tooling the bootstrap installs", () => {
  // The whole risk of a prebuilt base is drift: a dry run passing against
  // tooling the real sandbox does not have. These are the installs the
  // bootstrap performs, asserted on both sides.
  const dockerfile = renderBaseDockerfile();
  const bootstrap = renderCloudInit(baseSpec(), { mode: "container" });

  for (const marker of [
    "deb.nodesource.com/setup_22.x",
    "corepack enable",
    "corepack prepare pnpm@latest --activate",
    "corepack prepare yarn@stable --activate",
    "get.docker.com",
    "build-essential",
  ]) {
    assert.ok(dockerfile.includes(marker), `the base image is missing ${marker}`);
    assert.ok(bootstrap.includes(marker), `the bootstrap no longer does ${marker}`);
  }
});

test("the base creates the same agent user the bootstrap expects", () => {
  // A bind-mounted checkout arrives owned by this uid; a mismatch means the
  // agent cannot install into its own workspace.
  const dockerfile = renderBaseDockerfile();
  assert.ok(dockerfile.includes(`useradd -m -s /bin/bash ${AGENT_USER}`));
  assert.ok(dockerfile.includes(`chown -R ${AGENT_USER}:${AGENT_USER} /opt/nexus`));
  assert.ok(dockerfile.includes(`usermod -aG docker ${AGENT_USER}`));
});

test("the base ships python3, which the step recorder needs", () => {
  // `nexus_step_tail` JSON-escapes a log tail with python3 (spec 24 piece 2)
  // because ubuntu:22.04 does not ship jq. A base image without it would make
  // every boot-probe failure lose its tail.
  assert.ok(renderBaseDockerfile().includes("python3"));
});

test("the base bakes no project data and no secrets", () => {
  // It is a tooling cache shared by every project on this machine. Anything
  // project-specific in it would leak across projects and go stale besides.
  const dockerfile = renderBaseDockerfile().toLowerCase();
  for (const forbidden of [
    "token",
    "secret",
    "api_key",
    "apikey",
    "password",
    "/opt/nexus/stack",
    "git clone",
    "docker-compose",
  ]) {
    assert.ok(
      !dockerfile.includes(forbidden),
      `the base image Dockerfile mentions ${forbidden}`,
    );
  }
});

test("the base does not start dockerd", () => {
  // The bootstrap's container branch launches it and waits for the socket;
  // two places doing that is one place too many, and an image cannot hold a
  // running daemon anyway.
  const dockerfile = renderBaseDockerfile();
  assert.ok(!/^\s*(CMD|ENTRYPOINT)/m.test(dockerfile));
  assert.ok(!dockerfile.includes("dockerd &"));
});

test("it builds on the same distro the cloud image uses", () => {
  assert.ok(renderBaseDockerfile().startsWith(`# Generated`));
  assert.ok(renderBaseDockerfile().includes(`FROM ${BASE_IMAGE_FROM}`));
});

test("a dry run drops the agent tooling and keeps what it validates", () => {
  const spec = dryRunSpec(baseSpec());

  // Dropped: none of this decides whether the project builds.
  assert.equal(spec.installClaudeCode, false);
  assert.equal(spec.installAgentBrowser, false);
  assert.equal(spec.installCloudflared, false);
  assert.equal(spec.installTailscale, false);

  // Kept: Docker is what brings the stack services up, and a dry run that
  // dropped it would report a stack as broken for a reason the real provision
  // would not have.
  assert.equal(spec.installDocker, true);
  assert.equal(spec.installNode, true);
  assert.deepEqual(spec.repos, baseSpec().repos);
});

test("dryRunSpec does not mutate its input", () => {
  const original = baseSpec();
  const copy = { ...original };
  dryRunSpec(original);
  assert.deepEqual(original, copy);
});

test("a dry-run bootstrap really is shorter", () => {
  // The claim this piece makes, asserted rather than assumed: the skipped
  // installs are the bulk of a cold bootstrap's wall clock.
  const full = renderCloudInit(baseSpec(), { mode: "container" });
  const dry = renderCloudInit(dryRunSpec(baseSpec()), { mode: "container" });

  assert.ok(dry.length < full.length);
  for (const gone of [
    "@anthropic-ai/claude-code",
    "playwright install",
    "cloudflared",
  ]) {
    assert.ok(full.includes(gone), `the full bootstrap no longer does ${gone}`);
    assert.ok(!dry.includes(gone), `a dry run still does ${gone}`);
  }
});

test("a dry run still installs, builds and probes", () => {
  // The part being validated must survive the trimming, or the speed is bought
  // by not testing anything.
  const dry = renderCloudInit(
    dryRunSpec(
      baseSpec({
        repos: [
          {
            name: "app",
            repoUrl: "https://github.com/acme/app.git",
            installCommand: "pnpm install",
            buildCommand: "pnpm build",
            runCommand: "pnpm dev",
            runPort: 3000,
          },
        ],
      }),
    ),
    { mode: "container" },
  );
  assert.ok(dry.includes("install:app"));
  assert.ok(dry.includes("build:app"));
  assert.ok(dry.includes("nexus_boot_probe 'boot:app'"));
});

test("DRY_RUN_SKIPS never turns anything on", () => {
  // A skip list that enabled something would be a speed-up that changed what
  // is being tested.
  for (const [key, value] of Object.entries(DRY_RUN_SKIPS)) {
    assert.equal(value, false, `${key} is not a skip`);
  }
});
