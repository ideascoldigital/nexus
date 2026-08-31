/**
 * Pinning a repository to a git credential.
 *
 * The bug behind this: with several tokens saved for one host — a personal
 * GitHub account plus an org one is ordinary — the clone used whichever was
 * saved first. That is the wrong account roughly half the time, and git answers
 * a wrong token on a private repo with a username prompt, so the failure did
 * not even name what it had tried. These routes are how a repository records
 * the answer instead of leaving it to be guessed.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { POST as addRepository } from "./projects/[projectId]/repositories/route";
import { PUT as updateRepository } from "./projects/[projectId]/repositories/[repoId]/route";

let projectId: string;
let githubCredentialId: string;
let awsCredentialId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-repo-routes-test", name: "Test" },
  });
  const project = await prisma.project.create({
    data: { name: "Main", workspaceId: workspace.id },
  });
  projectId = project.id;

  const [github, aws] = await Promise.all([
    prisma.cloudCredential.create({
      data: {
        workspaceId: workspace.id,
        name: "github-org",
        provider: "github",
        data: { token: "ghp_org" },
      },
    }),
    prisma.cloudCredential.create({
      data: {
        workspaceId: workspace.id,
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
  addRepository(
    new NextRequest("http://test/api/repositories", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId }) },
  );

const put = (repoId: string, body: unknown) =>
  updateRepository(
    new NextRequest("http://test/api/repositories", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId, repoId }) },
  );

test("a repository can be created pinned to a git credential", async () => {
  const res = await post({
    name: "web",
    repoUrl: "https://github.com/acme/web.git",
    gitCredentialId: githubCredentialId,
  });
  assert.equal(res.status, 201);
  const repo = (await res.json()) as { id: string; gitCredentialId: string };
  assert.equal(repo.gitCredentialId, githubCredentialId);
});

test("no credential given leaves the repo on the provider-wide fallback", async () => {
  const res = await post({
    name: "unpinned",
    repoUrl: "https://github.com/acme/unpinned.git",
  });
  assert.equal(res.status, 201);
  const repo = (await res.json()) as { gitCredentialId: string | null };
  assert.equal(repo.gitCredentialId, null);
});

// A non-git credential satisfies the foreign key and would then be silently
// ignored — the clone only ever asks for the *remote's* provider. Refusing it
// is the difference between a visible error and a repo that never authenticates
// and never says why.
test("a credential that is not a git one is refused on create", async () => {
  const res = await post({
    name: "wrong-kind",
    repoUrl: "https://github.com/acme/x.git",
    gitCredentialId: awsCredentialId,
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a saved git credential/i);
});

test("a credential id that matches nothing is refused on create", async () => {
  const res = await post({
    name: "ghost",
    repoUrl: "https://github.com/acme/y.git",
    gitCredentialId: "cred-that-never-existed",
  });
  assert.equal(res.status, 400);
});

test("an existing repository can be repointed at another credential", async () => {
  const created = await post({
    name: "repoint",
    repoUrl: "https://github.com/acme/repoint.git",
  });
  const { id } = (await created.json()) as { id: string };

  const res = await put(id, { gitCredentialId: githubCredentialId });
  assert.equal(res.status, 200);
  const repo = (await res.json()) as { gitCredentialId: string | null };
  assert.equal(repo.gitCredentialId, githubCredentialId);
});

// The form's "Automatic" option submits "", which must mean "no credential"
// rather than a foreign key that matches nothing.
test("clearing the credential returns the repo to the fallback", async () => {
  const created = await post({
    name: "clearable",
    repoUrl: "https://github.com/acme/clearable.git",
    gitCredentialId: githubCredentialId,
  });
  const { id } = (await created.json()) as { id: string };

  const res = await put(id, { gitCredentialId: "" });
  assert.equal(res.status, 200);
  const repo = (await res.json()) as { gitCredentialId: string | null };
  assert.equal(repo.gitCredentialId, null);
});

test("a non-git credential is refused on update too", async () => {
  const created = await post({
    name: "guarded",
    repoUrl: "https://github.com/acme/guarded.git",
  });
  const { id } = (await created.json()) as { id: string };

  const res = await put(id, { gitCredentialId: awsCredentialId });
  assert.equal(res.status, 400);

  // The row must be untouched — a rejected update that half-applied would be
  // worse than one that failed outright.
  const row = await prisma.repository.findUnique({ where: { id } });
  assert.equal(row?.gitCredentialId, null);
});

// Deleting a credential must not delete repositories that referenced it: the
// checkout is still there and still valid, it just needs a new token.
test("deleting a credential unpins the repositories using it", async () => {
  const doomed = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-repo-routes-test",
      name: "temporary",
      provider: "github",
      data: { token: "ghp_temp" },
    },
  });
  const created = await post({
    name: "survivor",
    repoUrl: "https://github.com/acme/survivor.git",
    gitCredentialId: doomed.id,
  });
  const { id } = (await created.json()) as { id: string };

  await prisma.cloudCredential.delete({ where: { id: doomed.id } });

  const row = await prisma.repository.findUnique({ where: { id } });
  assert.ok(row, "the repository outlived the credential");
  assert.equal(row?.gitCredentialId, null);
});
