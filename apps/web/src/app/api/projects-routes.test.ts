/**
 * Creating a project with repositories that name their git credential.
 *
 * The gap behind this: the wizard's manual mode could take a git URL but had
 * no way to say which saved token clones it, so private repos fell back to
 * the provider's first credential — the wrong account roughly half the time
 * with several saved. The create route must accept the pick, persist it, and
 * reject credentials that are not git ones (same rule as the repositories
 * route).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { POST as createProject } from "./projects/route";
import { GET as getDefaults } from "./projects/defaults/route";

let githubCredentialId: string;
let awsCredentialId: string;

const workspaceId = "ws-projects-routes-test";

before(async () => {
  process.env.NEXUX_TEST_WORKSPACE = workspaceId;
  await prisma.workspace.create({
    data: { id: workspaceId, name: "Test" },
  });

  const [github, aws] = await Promise.all([
    prisma.cloudCredential.create({
      data: {
        workspaceId,
        name: "github-org",
        provider: "github",
        data: { token: "ghp_org" },
      },
    }),
    prisma.cloudCredential.create({
      data: {
        workspaceId,
        name: "aws-main",
        provider: "aws",
        data: { accessKeyId: "x", secretAccessKey: "y" },
      },
    }),
  ]);
  githubCredentialId = github.id;
  awsCredentialId = aws.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  createProject(
    new NextRequest("http://test/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );

test("persists the repo's git credential pick", async () => {
  const res = await post({
    name: "With credential",
    repositories: [
      {
        name: "api",
        repoUrl: "https://github.com/org/api",
        gitCredentialId: githubCredentialId,
      },
    ],
  });
  assert.equal(res.status, 201);
  const project = await res.json();
  assert.equal(project.repositories[0].gitCredentialId, githubCredentialId);
});

test("no pick stores null and still creates the project", async () => {
  const res = await post({
    name: "Without credential",
    repositories: [
      { name: "api", repoUrl: "https://github.com/org/api" },
    ],
  });
  assert.equal(res.status, 201);
  const project = await res.json();
  assert.equal(project.repositories[0].gitCredentialId, null);
});

test("rejects a credential that is not a git one", async () => {
  const res = await post({
    name: "Wrong provider",
    repositories: [
      {
        name: "api",
        repoUrl: "https://github.com/org/api",
        gitCredentialId: awsCredentialId,
      },
    ],
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "Not a saved git credential");
  // Rejected atomically — no half-created project left behind.
  assert.equal(
    await prisma.project.count({ where: { name: "Wrong provider" } }),
    0,
  );
});

test("rejects an unknown credential id", async () => {
  const res = await post({
    name: "Unknown credential",
    repositories: [
      {
        name: "api",
        repoUrl: "https://github.com/org/api",
        gitCredentialId: "cred-does-not-exist",
      },
    ],
  });
  assert.equal(res.status, 400);
});

test("bootstrap location default follows the install's role", async () => {
  // A host container can only write inside its workspace volume; suggesting
  // ~/Projects there is what turned every bootstrap into an EACCES 500.
  process.env.NEXUX_ROLE = "host";
  process.env.NEXUX_WORKSPACE_ROOT = "/workspace";
  try {
    const body = await (await getDefaults()).json();
    assert.equal(body.bootstrapParentPath, "/workspace");
  } finally {
    delete process.env.NEXUX_ROLE;
    delete process.env.NEXUX_WORKSPACE_ROOT;
  }
  const local = await (await getDefaults()).json();
  assert.equal(local.bootstrapParentPath, "~/Projects");
});
