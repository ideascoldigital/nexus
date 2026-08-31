import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, test } from "node:test";

// Env setup must stay above every other import — the service reaches
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "../app/api/routes.test-setup";
import { prisma } from "@nexux/db";

import {
  getProjectV2Items,
  mapColumnToStatus,
  mapProjectPriority,
  saveProjectLink,
  syncProjectV2,
} from "./github-projects";

// The board is the source of truth for status and iteration — these cover
// the free-form-name mapping, the GraphQL normalization (drafts kept, PRs
// dropped, issues upserted into the cache), and the re-sync that moves
// already-imported features without ever creating new ones.

const realFetch = global.fetch;

let accountId: string;
let projectId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-ghp-test", name: "GHP" },
  });
  const project = await prisma.project.create({
    data: { name: "GHP", workspaceId: workspace.id },
  });
  projectId = project.id;
  const account = await prisma.connectedAccount.create({
    data: {
      providerType: "github",
      label: "GH",
      authMode: "pat",
      status: "connected",
      oauthTokens: { create: { accessToken: "ghp_test" } },
    },
  });
  accountId = account.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

afterEach(() => {
  global.fetch = realFetch;
});

const fieldValues = (status?: string, iteration?: string, priority?: string) => ({
  nodes: [
    ...(status ? [{ name: status, field: { name: "Status" } }] : []),
    ...(iteration ? [{ title: iteration, field: { name: "Iteration" } }] : []),
    ...(priority ? [{ name: priority, field: { name: "Priority" } }] : []),
  ],
});

function mockBoard(items: unknown[]) {
  global.fetch = (async () =>
    Response.json({
      data: {
        node: {
          title: "Roadmap",
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: items,
          },
        },
      },
    })) as typeof fetch;
}

// --- column/priority mapping ------------------------------------------------

test("board column names map onto the kanban vocabulary", () => {
  assert.equal(mapColumnToStatus("In Progress"), "in_progress");
  assert.equal(mapColumnToStatus("In review"), "in_review");
  assert.equal(mapColumnToStatus("Done"), "done");
  assert.equal(mapColumnToStatus("Todo"), "todo");
  assert.equal(mapColumnToStatus("Ready"), "todo");
  assert.equal(mapColumnToStatus("Backlog"), "backlog");
  assert.equal(mapColumnToStatus(null), "backlog");
  assert.equal(mapColumnToStatus("Anything else"), "backlog");
});

test("project priority names map onto Nexus priorities", () => {
  assert.equal(mapProjectPriority("P0"), "urgent");
  assert.equal(mapProjectPriority("High"), "high");
  assert.equal(mapProjectPriority("Low"), "low");
  assert.equal(mapProjectPriority(null), "medium");
});

// --- board listing ----------------------------------------------------------

const project = (id: string, title: string, number = 1, closed = false) => ({
  id,
  title,
  number,
  closed,
});

/**
 * Routes the three listing sources apart: REST for scopes and org logins,
 * GraphQL for the boards themselves.
 */
function mockGitHub(opts: {
  scopes?: string | null;
  orgs?: { login: string }[];
  own?: unknown[];
  orgProjects?: Record<string, unknown[]>;
  repos?: { nameWithOwner: string; projects: unknown[] }[];
}) {
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/user")) {
      return Response.json(
        { login: "dev" },
        { headers: opts.scopes == null ? {} : { "x-oauth-scopes": opts.scopes } }
      );
    }
    if (href.includes("/user/orgs")) return Response.json(opts.orgs ?? []);

    const body = String(init?.body ?? "");
    if (body.includes("repositories(")) {
      return Response.json({
        data: {
          viewer: {
            repositories: {
              nodes: (opts.repos ?? []).map((r) => ({
                nameWithOwner: r.nameWithOwner,
                projectsV2: { nodes: r.projects },
              })),
            },
          },
        },
      });
    }
    if (body.includes("organization(login:")) {
      const vars = (JSON.parse(body) as { variables: Record<string, string> })
        .variables;
      const data: Record<string, unknown> = {};
      for (const [key, login] of Object.entries(vars)) {
        data[`o${key.slice(1)}`] = {
          projectsV2: { nodes: opts.orgProjects?.[login] ?? [] },
        };
      }
      return Response.json({ data });
    }
    return Response.json({
      data: {
        viewer: { login: "dev", projectsV2: { nodes: opts.own ?? [] } },
      },
    });
  }) as typeof fetch;
}

test("boards come from the viewer, its orgs and its repo links, deduped", async () => {
  mockGitHub({
    scopes: "project, read:user, repo, read:org",
    orgs: [{ login: "acme" }],
    own: [project("PVT_1", "Mine"), project("PVT_closed", "Archived", 2, true)],
    orgProjects: { acme: [project("PVT_2", "Acme roadmap", 4)] },
    // Already listed under its org — a repo link must not duplicate it.
    repos: [
      { nameWithOwner: "acme/app", projects: [project("PVT_2", "Acme roadmap", 4)] },
      { nameWithOwner: "other/lib", projects: [project("PVT_3", "Someone else's", 7)] },
    ],
  });

  const { listProjectsV2 } = await import("./github-projects");
  const { projects, warning } = await listProjectsV2(accountId);

  assert.deepEqual(projects, [
    { id: "PVT_1", title: "Mine", number: 1, owner: "dev" },
    { id: "PVT_2", title: "Acme roadmap", number: 4, owner: "acme" },
    { id: "PVT_3", title: "Someone else's", number: 7, owner: "other" },
  ]);
  assert.equal(warning, null);
});

test("a token without read:org still lists boards, and says what it can't see", async () => {
  mockGitHub({
    scopes: "project, read:user, repo",
    orgs: [],
    own: [project("PVT_1", "Mine")],
  });

  const { listProjectsV2 } = await import("./github-projects");
  const { projects, warning } = await listProjectsV2(accountId);
  assert.deepEqual(projects, [
    { id: "PVT_1", title: "Mine", number: 1, owner: "dev" },
  ]);
  assert.match(warning ?? "", /read:org/);
});

test("a source that fails degrades to nothing instead of taking the rest down", async () => {
  mockGitHub({ scopes: null, orgs: [{ login: "acme" }], own: [project("PVT_1", "Mine")] });
  const inner = global.fetch;
  global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(init?.body ?? "").includes("repositories(")) {
      return Response.json({ errors: [{ message: "boom" }] });
    }
    return inner(url, init);
  }) as typeof fetch;

  const { listProjectsV2 } = await import("./github-projects");
  const { projects, warning } = await listProjectsV2(accountId);
  assert.deepEqual(projects.map((p) => p.id), ["PVT_1"]);
  // Fine-grained tokens send no scope header — don't claim a missing scope.
  assert.equal(warning, null);
});

// --- resolving a board by URL -----------------------------------------------

test("board references parse from URLs and the owner/number shorthand", async () => {
  const { parseProjectRef } = await import("./github-projects");
  assert.deepEqual(parseProjectRef("https://github.com/orgs/acme/projects/3"), {
    login: "acme",
    number: 3,
  });
  assert.deepEqual(
    parseProjectRef("https://github.com/users/dev/projects/1/views/2"),
    { login: "dev", number: 1 }
  );
  assert.deepEqual(parseProjectRef(" acme/12 "), { login: "acme", number: 12 });
  assert.equal(parseProjectRef("https://github.com/acme/app"), null);
});

test("resolving by URL keeps the owner type GitHub actually found", async () => {
  // The wrong owner type comes back as a NOT_FOUND error beside usable data.
  global.fetch = (async () =>
    Response.json({
      data: {
        organization: null,
        user: { projectV2: { id: "PVT_9", title: "Shared board", number: 5 } },
      },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Organization" }],
    })) as typeof fetch;

  const { resolveProjectV2 } = await import("./github-projects");
  assert.deepEqual(
    await resolveProjectV2(accountId, "https://github.com/users/someone/projects/5"),
    { id: "PVT_9", title: "Shared board", number: 5, owner: "someone" }
  );
});

test("resolving a board the token cannot see explains why", async () => {
  global.fetch = (async () =>
    Response.json({ data: { organization: null, user: null } })) as typeof fetch;

  const { resolveProjectV2 } = await import("./github-projects");
  await assert.rejects(
    () => resolveProjectV2(accountId, "https://github.com/orgs/acme/projects/3"),
    /No project #3 under "acme"/
  );
  await assert.rejects(
    () => resolveProjectV2(accountId, "not a board"),
    /Paste a board URL/
  );
});

// --- item normalization -----------------------------------------------------

test("items normalize: issues cached, drafts kept, PRs dropped", async () => {
  mockBoard([
    {
      id: "item1",
      type: "ISSUE",
      fieldValues: fieldValues("In Progress", "Sprint 1", "P1"),
      content: {
        number: 12,
        title: "Fix auth",
        body: "details",
        state: "OPEN",
        url: "https://github.com/acme/app/issues/12",
        repository: { name: "app", owner: { login: "acme" } },
      },
    },
    {
      id: "item2",
      type: "DRAFT_ISSUE",
      fieldValues: fieldValues("Todo"),
      content: { title: "Just an idea", body: null },
    },
    {
      id: "item3",
      type: "PULL_REQUEST",
      fieldValues: fieldValues("Done"),
      content: { number: 9, title: "a PR" },
    },
  ]);

  const { title, items } = await getProjectV2Items(accountId, "PVT_x");
  assert.equal(title, "Roadmap");
  assert.equal(items.length, 2);

  assert.equal(items[0].statusColumn, "In Progress");
  assert.equal(items[0].iteration, "Sprint 1");
  assert.equal(items[0].priority, "P1");
  assert.equal(items[0].issue?.repo, "acme/app");
  const cached = await prisma.gitHubIssue.findFirstOrThrow({
    where: { owner: "acme", repo: "app", issueNumber: 12 },
  });
  assert.equal(cached.state, "open");
  assert.equal(items[0].issue?.id, cached.id);

  assert.equal(items[1].issue, null);
  assert.equal(items[1].title, "Just an idea");
});

// --- re-sync ----------------------------------------------------------------

test("sync moves an imported feature to the board's column and iteration", async () => {
  mockBoard([
    {
      id: "item1",
      type: "ISSUE",
      fieldValues: fieldValues("Done", "Sprint 2"),
      content: {
        number: 12,
        title: "Fix auth",
        body: null,
        state: "CLOSED",
        url: "https://github.com/acme/app/issues/12",
        repository: { name: "app", owner: { login: "acme" } },
      },
    },
  ]);

  const issue = await prisma.gitHubIssue.findFirstOrThrow({
    where: { issueNumber: 12 },
  });
  const phase = await prisma.devPhase.create({
    data: { projectId, name: "Sprint 2", order: 0 },
  });
  const feature = await prisma.feature.create({
    data: {
      projectId,
      title: "Fix auth",
      status: "in_progress",
      featureIssues: { create: { issueId: issue.id } },
    },
  });
  await saveProjectLink(projectId, {
    accountId,
    ghProjectId: "PVT_x",
    title: "Roadmap",
  });

  const result = await syncProjectV2(projectId);
  assert.deepEqual(result, { checked: 1, updated: 1 });

  const synced = await prisma.feature.findUniqueOrThrow({
    where: { id: feature.id },
  });
  assert.equal(synced.status, "done");
  assert.equal(synced.devPhaseId, phase.id);

  // A second pass finds nothing to change.
  mockBoard([
    {
      id: "item1",
      type: "ISSUE",
      fieldValues: fieldValues("Done", "Sprint 2"),
      content: {
        number: 12,
        title: "Fix auth",
        body: null,
        state: "CLOSED",
        url: "https://github.com/acme/app/issues/12",
        repository: { name: "app", owner: { login: "acme" } },
      },
    },
  ]);
  assert.deepEqual(await syncProjectV2(projectId), { checked: 1, updated: 0 });
});

test("sync without a stored link refuses instead of guessing", async () => {
  const other = await prisma.project.create({
    data: { name: "Unlinked", workspaceId: "ws-ghp-test" },
  });
  await assert.rejects(() => syncProjectV2(other.id), /not linked/);
});

test("an unknown iteration leaves the feature's phase untouched", async () => {
  mockBoard([
    {
      id: "item1",
      type: "ISSUE",
      fieldValues: fieldValues("In Progress", "Sprint 99"),
      content: {
        number: 12,
        title: "Fix auth",
        body: null,
        state: "OPEN",
        url: "https://github.com/acme/app/issues/12",
        repository: { name: "app", owner: { login: "acme" } },
      },
    },
  ]);
  await syncProjectV2(projectId);
  const feature = await prisma.feature.findFirstOrThrow({
    where: { projectId, title: "Fix auth" },
  });
  assert.equal(feature.status, "in_progress");
  // Sprint 2's phase from the previous test stays — Sprint 99 matched nothing.
  assert.notEqual(feature.devPhaseId, null);
});
