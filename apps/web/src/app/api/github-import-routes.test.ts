import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { POST as importRoute } from "./projects/[projectId]/github-import/route";

// The GitHub half of the shared import path (lib/feature-import): the same
// transaction the ClickUp tests drive, but linking FeatureIssue provenance.

let projectId: string;
let issueId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-gh-import-test", name: "GH Import" },
  });
  const project = await prisma.project.create({
    data: { name: "GH Import", workspaceId: workspace.id },
  });
  projectId = project.id;

  const account = await prisma.connectedAccount.create({
    data: {
      providerType: "github",
      label: "Test GH",
      authMode: "pat",
      status: "connected",
      oauthTokens: { create: { accessToken: "ghp_test" } },
    },
  });
  const issue = await prisma.gitHubIssue.create({
    data: {
      accountId: account.id,
      owner: "acme",
      repo: "web",
      issueNumber: 7,
      title: "Fix login",
      state: "open",
      url: "https://github.com/acme/web/issues/7",
    },
  });
  issueId = issue.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const runImport = (pid: string, body: unknown) =>
  importRoute(
    new NextRequest(`http://test/api/projects/${pid}/github-import`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: pid }) }
  );

test("import creates a phase, its features, and FeatureIssue provenance", async () => {
  const res = await runImport(projectId, {
    phases: [
      {
        name: "web",
        goal: "Issues from the repo",
        features: [
          {
            title: "Fix login",
            description: "From GitHub",
            priority: "high",
            status: "backlog",
            issueId,
          },
          { title: "Hand-added", priority: "medium", status: "todo" },
        ],
      },
    ],
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).featureCount, 2);

  const phase = await prisma.devPhase.findFirstOrThrow({ where: { projectId } });
  assert.equal(phase.name, "web");
  const features = await prisma.feature.findMany({
    where: { projectId },
    orderBy: { title: "asc" },
    include: { featureIssues: true },
  });
  assert.equal(features.length, 2);
  assert.equal(features[0].devPhaseId, phase.id);
  assert.equal(features[0].featureIssues[0]?.issueId, issueId);
  assert.equal(features[1].featureIssues.length, 0);
});

test("import without createPhase leaves features phaseless", async () => {
  const res = await runImport(projectId, {
    phases: [
      {
        name: "ignored",
        createPhase: false,
        features: [{ title: "Loose issue", priority: "low", status: "backlog" }],
      },
    ],
  });
  assert.equal(res.status, 201);
  const feature = await prisma.feature.findFirstOrThrow({
    where: { projectId, title: "Loose issue" },
  });
  assert.equal(feature.devPhaseId, null);
});

test("import refuses a status outside the kanban's vocabulary", async () => {
  const res = await runImport(projectId, {
    phases: [
      {
        name: "Bad",
        features: [{ title: "x", priority: "medium", status: "doing" }],
      },
    ],
  });
  assert.equal(res.status, 400);
});

test("import into an unknown project is a 404", async () => {
  const res = await runImport("no-such-project", {
    phases: [
      { name: "P", features: [{ title: "x", priority: "medium", status: "backlog" }] },
    ],
  });
  assert.equal(res.status, 404);
});
