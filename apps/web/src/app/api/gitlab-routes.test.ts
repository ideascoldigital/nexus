import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import {
  GET as listServers,
  POST as addServer,
} from "./gitlab/accounts/route";
import {
  DELETE as deleteServer,
  PATCH as revalidateServer,
} from "./gitlab/accounts/[accountId]/route";
import { GET as projectsRoute } from "./gitlab/accounts/[accountId]/projects/route";
import { POST as syncRoute } from "./gitlab/accounts/[accountId]/sync/route";
import { GET as issuesRoute } from "./gitlab/issues/route";
import { GET as groupsRoute } from "./gitlab/accounts/[accountId]/groups/route";
import { GET as epicsRoute } from "./gitlab/epics/route";
import { GET as resolveRoute } from "./gitlab/accounts/[accountId]/resolve/route";
import { POST as importRoute } from "./projects/[projectId]/gitlab-import/route";
import {
  DELETE as unlinkRoute,
  GET as linkedRoute,
  POST as linkRoute,
} from "./projects/[projectId]/features/[featureId]/gitlab-issues/route";
import { normalizeBaseUrl } from "@/services/gitlab";

// Self-hosted is the whole point of the integration, so these drive the real
// handlers with a fake instance at the fetch boundary and assert that every
// call actually goes to the configured host — a hardcoded gitlab.com would
// pass a happy-path test and fail every real company server.

const realFetch = global.fetch;

const SELF_HOSTED = "https://gitlab.acme.dev";

type FakeIssue = {
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  labels: string[];
  milestone: { title: string } | null;
  author: { username: string; name: string; avatar_url: string } | null;
  assignees: { username: string }[];
  closed_at: string | null;
  created_at: string;
  web_url: string;
  /** Group and epic listings carry `group/sub/project#12` here; a project one does not. */
  references?: { full: string };
  epic?: { id: number; iid: number; title: string; group_id: number } | null;
};

const fakeIssue = (over: Partial<FakeIssue> & { iid: number }): FakeIssue => ({
  project_id: 12,
  title: `Issue ${over.iid}`,
  description: null,
  state: "opened",
  labels: [],
  milestone: null,
  author: { username: "jane", name: "Jane", avatar_url: "" },
  assignees: [],
  closed_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  web_url: `${SELF_HOSTED}/acme/web/-/issues/${over.iid}`,
  ...over,
});

type FakeEpic = {
  id: number;
  iid: number;
  group_id: number;
  parent_id: number | null;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  web_url: string;
  labels: string[];
  author: { username: string } | null;
  start_date: string | null;
  due_date: string | null;
  closed_at: string | null;
  created_at: string;
  references: { full: string };
};

const fakeEpic = (
  over: Partial<FakeEpic> & { id: number; iid: number; group_id: number },
): FakeEpic => ({
  parent_id: null,
  title: `Epic ${over.iid}`,
  description: null,
  state: "opened",
  web_url: `${SELF_HOSTED}/groups/acme/-/epics/${over.iid}`,
  labels: [],
  author: { username: "jane" },
  start_date: null,
  due_date: null,
  closed_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  references: { full: `acme&${over.iid}` },
  ...over,
});

/** An issue as the GraphQL board query returns it — ids as strings, nested nodes. */
type GqlIssue = {
  iid: string;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  webUrl: string;
  createdAt: string;
  closedAt: string | null;
  reference: string;
  projectId: number;
  status: { name: string } | null;
  milestone: { title: string } | null;
  epic: { id: string; iid: string; title: string; group: { id: string } } | null;
  labels: { nodes: { title: string }[] };
  author: { username: string } | null;
  assignees: { nodes: { username: string }[] };
};

/** Every URL the fake instance was asked for, in order. */
let calls: string[] = [];
/** The PRIVATE-TOKEN header of each call, in order. */
let tokens: string[] = [];

/** Fake GitLab: identity, project listing and paged issues. */
function mockGitLab(
  opts: {
    userOk?: boolean;
    username?: string;
    projects?: { id: number; path_with_namespace: string }[];
    issues?: FakeIssue[];
    /** Split issues across two pages to exercise `x-next-page`. */
    paged?: boolean;
    groups?: { id: number; name: string; full_path: string }[];
    /** Issues returned by the group-scoped listing (they span projects). */
    groupIssues?: FakeIssue[];
    epics?: FakeEpic[];
    /** Issues under an epic, keyed by its iid. */
    epicIssues?: Record<number, FakeIssue[]>;
    /** Board columns and issues, served over GraphQL like the real thing. */
    board?: {
      name: string;
      milestone: string | null;
      columns: { title: string; listType: string; position: number | null }[];
      issues: GqlIssue[];
    } | null;
  } = {},
) {
  const {
    userOk = true,
    username = "jane",
    projects = [{ id: 12, path_with_namespace: "acme/web" }],
    issues = [],
    paged = false,
    groups = [
      { id: 5, name: "acme", full_path: "acme" },
      { id: 6, name: "infra", full_path: "acme/infra" },
    ],
    groupIssues = [],
    epics = [],
    epicIssues = {},
    board = null,
  } = opts;

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    tokens.push(
      String(
        (init?.headers as Record<string, string> | undefined)?.[
          "PRIVATE-TOKEN"
        ] ?? "",
      ),
    );
    const parsed = new URL(url);

    // GraphQL is where board columns live — REST reports `label: null` for
    // every list on 18.x and no list type at all.
    if (parsed.pathname.endsWith("/api/graphql")) {
      if (!board) return Response.json({ data: { namespace: { board: null } } });
      const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");
      if (query.includes("lists")) {
        return Response.json({
          data: {
            namespace: {
              board: {
                name: board.name,
                milestone: board.milestone ? { title: board.milestone } : null,
                lists: { nodes: board.columns },
              },
            },
          },
        });
      }
      return Response.json({
        data: {
          namespace: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: board.issues,
            },
          },
        },
      });
    }

    if (parsed.pathname.endsWith("/api/v4/user")) {
      return userOk
        ? Response.json({
            username,
            name: "Jane",
            avatar_url: `${SELF_HOSTED}/avatar.png`,
            email: "jane@acme.dev",
            web_url: `${SELF_HOSTED}/${username}`,
          })
        : Response.json({ message: "401 Unauthorized" }, { status: 401 });
    }

    if (/\/api\/v4\/projects\/[^/]+$/.test(parsed.pathname)) {
      const ref = decodeURIComponent(parsed.pathname.split("/").pop()!);
      const found = projects.find(
        (p) => p.path_with_namespace === ref || String(p.id) === ref,
      );
      return found
        ? Response.json(found)
        : Response.json({ message: "404 Project Not Found" }, { status: 404 });
    }

    if (parsed.pathname.endsWith("/api/v4/projects")) {
      const search = parsed.searchParams.get("search");
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const matching = search
        ? projects.filter((p) => p.path_with_namespace.includes(search))
        : projects;
      return Response.json(page === 1 ? matching : []);
    }

    if (/\/api\/v4\/groups\/\d+\/epics\/\d+\/issues$/.test(parsed.pathname)) {
      const iid = Number(parsed.pathname.split("/").at(-2));
      const page = Number(parsed.searchParams.get("page") ?? "1");
      return Response.json(page === 1 ? (epicIssues[iid] ?? []) : []);
    }

    if (/\/api\/v4\/groups\/\d+\/epics$/.test(parsed.pathname)) {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const state = parsed.searchParams.get("state");
      const visible = state ? epics.filter((e) => e.state === state) : epics;
      return Response.json(page === 1 ? visible : []);
    }

    if (/\/api\/v4\/groups\/\d+\/issues$/.test(parsed.pathname)) {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const state = parsed.searchParams.get("state");
      const visible = state
        ? groupIssues.filter((i) => i.state === state)
        : groupIssues;
      return Response.json(page === 1 ? visible : []);
    }

    if (parsed.pathname.endsWith("/api/v4/groups")) {
      const search = parsed.searchParams.get("search");
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const matching = search
        ? groups.filter((g) => g.full_path.includes(search))
        : groups;
      return Response.json(page === 1 ? matching : []);
    }

    if (/\/api\/v4\/projects\/\d+\/issues$/.test(parsed.pathname)) {
      const page = Number(parsed.searchParams.get("page") ?? "1");
      const state = parsed.searchParams.get("state");
      const visible = state
        ? issues.filter((i) => i.state === state)
        : issues;
      if (!paged) {
        return Response.json(page === 1 ? visible : []);
      }
      const slice = visible.slice((page - 1) * 1, page * 1);
      return Response.json(slice, {
        headers: {
          "x-next-page": page * 1 < visible.length ? String(page + 1) : "",
        },
      });
    }

    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

let projectId: string;
let featureId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-gitlab-test", name: "GitLab" },
  });
  const project = await prisma.project.create({
    data: { name: "GitLab", workspaceId: workspace.id },
  });
  projectId = project.id;
  const feature = await prisma.feature.create({
    data: { projectId, title: "Existing feature" },
  });
  featureId = feature.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  calls = [];
  tokens = [];
  await prisma.gitLabIssue.deleteMany({});
  await prisma.gitLabEpic.deleteMany({});
  await prisma.connectedAccount.deleteMany({
    where: { providerType: "gitlab" },
  });
  await prisma.cloudCredential.deleteMany({ where: { provider: "gitlab" } });
});

afterEach(() => {
  global.fetch = realFetch;
});

// --- helpers ---------------------------------------------------------------

const post = (path: string, body: unknown) =>
  new NextRequest(`http://test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

const addServerWith = (body: unknown) =>
  addServer(post("/api/gitlab/accounts", body));

const savedCredential = (token = "glpat-saved") =>
  prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-gitlab-test",
      name: "GitLab work",
      provider: "gitlab",
      data: { token },
    },
  });

/**
 * Register a server and return its id. 201 means a new row, 200 means an
 * existing one was refreshed — asserting the expected one is how these tests
 * pin down which adds are supposed to create and which are supposed to merge.
 */
async function connect(
  body: Record<string, unknown> = { pat: "glpat-pasted" },
  expected = 201,
): Promise<string> {
  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Acme GitLab",
    ...body,
  });
  assert.equal(res.status, expected, JSON.stringify(await res.clone().json()));
  return (await res.json()).id;
}

const sync = (accountId: string, body: unknown) =>
  syncRoute(post(`/api/gitlab/accounts/${accountId}/sync`, body), {
    params: Promise.resolve({ accountId }),
  });

const readIssues = (params: Record<string, string>) =>
  issuesRoute(
    new NextRequest(
      `http://test/api/gitlab/issues?${new URLSearchParams(params)}`,
    ),
  );

// --- instance URLs ---------------------------------------------------------

test("instance URLs are normalized to a bare origin", () => {
  assert.equal(normalizeBaseUrl("https://gitlab.acme.dev/"), SELF_HOSTED);
  assert.equal(normalizeBaseUrl("  gitlab.acme.dev  "), SELF_HOSTED);
  assert.equal(normalizeBaseUrl("https://gitlab.acme.dev/api/v4"), SELF_HOSTED);
  assert.equal(normalizeBaseUrl("https://gitlab.acme.dev:8443"), "https://gitlab.acme.dev:8443");
  // An install served under a subpath keeps it — the API hangs off it.
  assert.equal(
    normalizeBaseUrl("https://acme.dev/gitlab/"),
    "https://acme.dev/gitlab",
  );
  assert.throws(() => normalizeBaseUrl("   "), /required/);
});

// --- connecting a server ---------------------------------------------------

test("a pasted PAT is validated against the configured instance", async () => {
  mockGitLab();
  const accountId = await connect();

  assert.ok(
    calls[0].startsWith(`${SELF_HOSTED}/api/v4/user`),
    `expected the self-hosted instance, got ${calls[0]}`,
  );
  assert.equal(tokens[0], "glpat-pasted");

  const account = await prisma.connectedAccount.findUniqueOrThrow({
    where: { id: accountId },
  });
  const meta = account.metadata as { baseUrl: string; username: string };
  assert.equal(meta.baseUrl, SELF_HOSTED);
  assert.equal(meta.username, "jane");
  assert.equal(account.status, "connected");

  const stored = await prisma.oAuthToken.findFirstOrThrow({
    where: { accountId },
  });
  assert.equal(stored.accessToken, "glpat-pasted");
});

test("a saved GitLab credential is enough — no second token is stored", async () => {
  mockGitLab();
  const credential = await savedCredential();
  const accountId = await connect({ credentialId: credential.id });

  assert.equal(tokens[0], "glpat-saved");
  const account = await prisma.connectedAccount.findUniqueOrThrow({
    where: { id: accountId },
  });
  assert.equal(
    (account.metadata as { credentialId: string }).credentialId,
    credential.id,
  );
  assert.equal(await prisma.oAuthToken.count({ where: { accountId } }), 0);
});

test("a credential from another provider is refused", async () => {
  mockGitLab();
  const github = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-gitlab-test",
      name: "GitHub work",
      provider: "github",
      data: { token: "ghp_x" },
    },
  });
  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Wrong",
    credentialId: github.id,
  });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /pick a GitLab one/);
  await prisma.cloudCredential.delete({ where: { id: github.id } });
});

test("exactly one token source is required", async () => {
  mockGitLab();
  const credential = await savedCredential();
  for (const body of [
    {},
    { pat: "glpat-x", credentialId: credential.id },
  ]) {
    const res = await addServerWith({
      baseUrl: SELF_HOSTED,
      label: "Acme",
      ...body,
    });
    assert.equal(res.status, 400);
  }
});

test("a bad token surfaces as 401 and stores nothing", async () => {
  mockGitLab({ userOk: false });
  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Acme",
    pat: "glpat-bad",
  });
  assert.equal(res.status, 401);
  assert.equal(
    await prisma.connectedAccount.count({ where: { providerType: "gitlab" } }),
    0,
  );
});

test("re-pasting a PAT updates; another instance is a second server", async () => {
  mockGitLab();
  const first = await connect();
  const again = await connect({ pat: "glpat-rotated" }, 200);
  assert.equal(again, first, "a re-pasted PAT should rotate, not duplicate");

  const token = await prisma.oAuthToken.findFirstOrThrow({
    where: { accountId: first },
  });
  assert.equal(token.accessToken, "glpat-rotated");

  const other = await addServerWith({
    baseUrl: "https://gitlab.com",
    label: "Public",
    pat: "glpat-public",
  });
  assert.equal(other.status, 201);
  assert.notEqual((await other.json()).id, first);

  const listed = await (await listServers()).json();
  assert.equal(listed.length, 2);
});

// The case that exposed the old rule: one person routinely holds two tokens on
// one instance (a personal one and a scoped bot one). Keyed on the login alone,
// the second "Add server" silently overwrote the first and the card still
// showed exactly one row.
test("two credentials on one instance are two servers, same user or not", async () => {
  mockGitLab();
  const personal = await savedCredential("glpat-personal");
  const bot = await savedCredential("glpat-bot");

  const first = await connect({ credentialId: personal.id });
  const second = await connect({ credentialId: bot.id });
  assert.notEqual(second, first);

  const listed = await (await listServers()).json();
  assert.equal(listed.length, 2);
  // Neither borrows the other's credential.
  assert.deepEqual(
    listed.map((a: { metadata: { credentialId: string } }) => a.metadata.credentialId).sort(),
    [personal.id, bot.id].sort(),
  );
});

test("re-picking the same credential refreshes that server, not a sibling", async () => {
  mockGitLab();
  const personal = await savedCredential("glpat-personal");
  const bot = await savedCredential("glpat-bot");
  const first = await connect({ credentialId: personal.id });
  await connect({ credentialId: bot.id });

  const again = await connect({ credentialId: personal.id }, 200);
  assert.equal(again, first);
  assert.equal((await (await listServers()).json()).length, 2);
});

test("a credential-backed server keeps no token copy of its own", async () => {
  mockGitLab();
  const credential = await savedCredential();
  const accountId = await connect({ credentialId: credential.id });
  assert.equal(await prisma.oAuthToken.count({ where: { accountId } }), 0);

  // Re-registering must not start hoarding one either.
  await connect({ credentialId: credential.id }, 200);
  assert.equal(await prisma.oAuthToken.count({ where: { accountId } }), 0);
});

test("re-validation marks a server with a dead token as errored", async () => {
  mockGitLab();
  const accountId = await connect();

  mockGitLab({ userOk: false });
  const res = await revalidateServer(
    new NextRequest(`http://test/api/gitlab/accounts/${accountId}`, {
      method: "PATCH",
    }),
    { params: Promise.resolve({ accountId }) },
  );
  assert.equal(res.status, 401);
  const account = await prisma.connectedAccount.findUniqueOrThrow({
    where: { id: accountId },
  });
  assert.equal(account.status, "error");
});

// --- projects --------------------------------------------------------------

test("projects are searched on the instance, and a path resolves directly", async () => {
  mockGitLab({
    projects: [
      { id: 12, path_with_namespace: "acme/web" },
      { id: 13, path_with_namespace: "acme/infra" },
    ],
  });
  const accountId = await connect();

  const searched = await projectsRoute(
    new NextRequest(
      `http://test/api/gitlab/accounts/${accountId}/projects?search=infra`,
    ),
    { params: Promise.resolve({ accountId }) },
  );
  assert.deepEqual(
    (await searched.json()).map(
      (p: { path_with_namespace: string }) => p.path_with_namespace,
    ),
    ["acme/infra"],
  );
  assert.ok(calls.some((c) => c.includes("search=infra")));

  const byPath = await projectsRoute(
    new NextRequest(
      `http://test/api/gitlab/accounts/${accountId}/projects?path=acme/web`,
    ),
    { params: Promise.resolve({ accountId }) },
  );
  assert.equal((await byPath.json())[0].id, 12);
});

// --- syncing issues --------------------------------------------------------

test("sync caches issues and follows x-next-page", async () => {
  mockGitLab({
    issues: [fakeIssue({ iid: 1 }), fakeIssue({ iid: 2 })],
    paged: true,
  });
  const accountId = await connect();

  const res = await sync(accountId, { projectId: 12, projectPath: "acme/web" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).synced, 2);
  assert.equal(await prisma.gitLabIssue.count(), 2);
});

test("sync is an upsert keyed on the numeric project, and refreshes the path", async () => {
  mockGitLab({
    issues: [fakeIssue({ iid: 1, title: "Before", labels: ["bug"] })],
  });
  const accountId = await connect();
  await sync(accountId, { projectId: 12, projectPath: "acme/web" });

  // Same project id, renamed group, edited title: one row, both fields fresh.
  mockGitLab({
    issues: [fakeIssue({ iid: 1, title: "After", state: "closed" })],
  });
  await sync(accountId, { projectId: 12, projectPath: "acme-corp/web" });

  const rows = await prisma.gitLabIssue.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "After");
  assert.equal(rows[0].state, "closed");
  assert.equal(rows[0].projectPath, "acme-corp/web");
});

test("sync refuses a project path in place of the numeric id", async () => {
  mockGitLab();
  const accountId = await connect();
  const res = await sync(accountId, {
    projectId: "acme/web",
    projectPath: "acme/web",
  });
  assert.equal(res.status, 400);
});

test("cached issues are filtered by state, and 'all' means no filter", async () => {
  mockGitLab({
    issues: [
      fakeIssue({ iid: 1 }),
      fakeIssue({ iid: 2, state: "closed", closed_at: "2026-08-02T00:00:00Z" }),
    ],
  });
  const accountId = await connect();
  await sync(accountId, { projectId: 12, projectPath: "acme/web" });

  const open = await (
    await readIssues({ accountId, projectId: "12", state: "opened" })
  ).json();
  assert.deepEqual(
    open.map((i: { issueIid: number }) => i.issueIid),
    [1],
  );

  const all = await (
    await readIssues({ accountId, projectId: "12", state: "all" })
  ).json();
  assert.equal(all.length, 2);
});

test("reading issues without a numeric project is a 400", async () => {
  mockGitLab();
  const accountId = await connect();
  const res = await readIssues({ accountId, projectId: "acme/web" });
  assert.equal(res.status, 400);
});

// --- import + linking ------------------------------------------------------

test("import creates features carrying FeatureGitLabIssue provenance", async () => {
  mockGitLab({ issues: [fakeIssue({ iid: 7, title: "Fix login" })] });
  const accountId = await connect();
  await sync(accountId, { projectId: 12, projectPath: "acme/web" });
  const issue = await prisma.gitLabIssue.findFirstOrThrow();

  const res = await importRoute(
    post(`/api/projects/${projectId}/gitlab-import`, {
      phases: [
        {
          name: "web",
          goal: "Issues from the project",
          features: [
            {
              title: "Fix login",
              description: "From GitLab",
              priority: "high",
              status: "backlog",
              issueId: issue.id,
            },
            { title: "Hand-added", priority: "medium", status: "todo" },
          ],
        },
      ],
    }),
    { params: Promise.resolve({ projectId }) },
  );
  assert.equal(res.status, 201);
  assert.equal((await res.json()).featureCount, 2);

  const imported = await prisma.feature.findFirstOrThrow({
    where: { projectId, title: "Fix login" },
    include: { featureGitLabIssues: true, devPhase: true },
  });
  assert.equal(imported.devPhase?.name, "web");
  assert.equal(imported.featureGitLabIssues[0]?.issueId, issue.id);

  await prisma.feature.deleteMany({
    where: { projectId, title: { in: ["Fix login", "Hand-added"] } },
  });
  await prisma.devPhase.deleteMany({ where: { projectId } });
});

test("import into a missing project is a 404", async () => {
  const res = await importRoute(
    post("/api/projects/nope/gitlab-import", {
      phases: [
        {
          name: "x",
          features: [{ title: "t", priority: "medium", status: "backlog" }],
        },
      ],
    }),
    { params: Promise.resolve({ projectId: "nope" }) },
  );
  assert.equal(res.status, 404);
});

test("an issue links to a feature once and unlinks cleanly", async () => {
  mockGitLab({ issues: [fakeIssue({ iid: 9 })] });
  const accountId = await connect();
  await sync(accountId, { projectId: 12, projectPath: "acme/web" });
  const issue = await prisma.gitLabIssue.findFirstOrThrow();

  const params = Promise.resolve({ projectId, featureId });
  const path = `/api/projects/${projectId}/features/${featureId}/gitlab-issues`;

  assert.equal(
    (await linkRoute(post(path, { issueId: issue.id }), { params })).status,
    201,
  );
  // Linking twice is an upsert, not a unique-constraint crash.
  assert.equal(
    (await linkRoute(post(path, { issueId: issue.id }), { params })).status,
    201,
  );

  const linked = await (
    await linkedRoute(new NextRequest(`http://test${path}`), { params })
  ).json();
  assert.equal(linked.length, 1);
  assert.equal(linked[0].issue.issueIid, 9);

  const removed = await unlinkRoute(
    new NextRequest(`http://test${path}?issueId=${issue.id}`, {
      method: "DELETE",
    }),
    { params },
  );
  assert.equal(removed.status, 200);
  assert.equal(await prisma.featureGitLabIssue.count(), 0);
});

test("unlinking without an issueId is a 400", async () => {
  const res = await unlinkRoute(
    new NextRequest(
      `http://test/api/projects/${projectId}/features/${featureId}/gitlab-issues`,
      { method: "DELETE" },
    ),
    { params: Promise.resolve({ projectId, featureId }) },
  );
  assert.equal(res.status, 400);
});

test("deleting a server takes its cached issues with it", async () => {
  mockGitLab({ issues: [fakeIssue({ iid: 1 })] });
  const accountId = await connect();
  await sync(accountId, { projectId: 12, projectPath: "acme/web" });
  assert.equal(await prisma.gitLabIssue.count(), 1);

  const res = await deleteServer(
    new NextRequest(`http://test/api/gitlab/accounts/${accountId}`, {
      method: "DELETE",
    }),
    { params: Promise.resolve({ accountId }) },
  );
  assert.equal(res.status, 200);
  assert.equal(await prisma.gitLabIssue.count(), 0);
});

// --- diagnosing an unreachable instance ------------------------------------

/** undici's shape: a bare "fetch failed" with the real reason in `cause`. */
function mockFetchThrowing(code: string, message: string) {
  global.fetch = (async () => {
    const inner = Object.assign(new Error(message), { code });
    throw new TypeError("fetch failed", { cause: inner });
  }) as typeof fetch;
}

test("a transport failure reports the underlying cause, not a guess", async () => {
  mockFetchThrowing("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:443");
  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Acme",
    pat: "glpat-x",
  });
  assert.equal(res.status, 500);
  const { error } = await res.json();
  assert.match(error, /gitlab\.acme\.dev/);
  assert.match(error, /ECONNREFUSED/);
});

test("an untrusted certificate names the fix instead of blaming the URL", async () => {
  mockFetchThrowing(
    "SELF_SIGNED_CERT_IN_CHAIN",
    "self-signed certificate in certificate chain",
  );
  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Acme",
    pat: "glpat-x",
  });
  const { error } = await res.json();
  assert.match(error, /NODE_EXTRA_CA_CERTS/);
});

test("a hostname that does not resolve says so", async () => {
  mockFetchThrowing("ENOTFOUND", "getaddrinfo ENOTFOUND gitlab.acme.dev");
  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Acme",
    pat: "glpat-x",
  });
  const { error } = await res.json();
  assert.match(error, /does not resolve/);
});

// --- groups, epics and the scopes above a project --------------------------

const EPIC_IN_ANOTHER_GROUP = { id: 972, iid: 586, title: "Router HA", group_id: 17 };

/** A group listing issue: carries `references.full` and maybe an epic. */
const groupIssue = (
  iid: number,
  path: string,
  over: Partial<FakeIssue> = {},
): FakeIssue =>
  fakeIssue({
    iid,
    project_id: path === "acme/web" ? 12 : 13,
    references: { full: `${path}#${iid}` },
    ...over,
  });

test("groups are searched on the instance", async () => {
  mockGitLab();
  const accountId = await connect();
  const res = await groupsRoute(
    new NextRequest(
      `http://test/api/gitlab/accounts/${accountId}/groups?search=infra`,
    ),
    { params: Promise.resolve({ accountId }) },
  );
  assert.deepEqual(
    (await res.json()).map((g: { full_path: string }) => g.full_path),
    ["acme/infra"],
  );
});

test("a group sync spans projects and takes each path from references.full", async () => {
  mockGitLab({
    groupIssues: [
      groupIssue(1, "acme/web"),
      groupIssue(2, "acme/infra/tf"),
      groupIssue(3, "acme/infra/tf"),
    ],
  });
  const accountId = await connect();

  const res = await sync(accountId, {
    mode: "group",
    groupId: 5,
    groupPath: "acme",
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.synced, 3);
  assert.equal(body.truncated, false);

  const rows = await prisma.gitLabIssue.findMany({ orderBy: { issueIid: "asc" } });
  assert.deepEqual(
    rows.map((r) => r.projectPath),
    ["acme/web", "acme/infra/tf", "acme/infra/tf"],
  );
});

// The case that forced the epic reference to be denormalized instead of joined:
// on a live instance an issue fetched from `operators` belonged to an epic in
// `civo`, a group that may never be synced at all.
test("an issue keeps an epic that lives in another group", async () => {
  mockGitLab({
    groupIssues: [groupIssue(1, "acme/web", { epic: EPIC_IN_ANOTHER_GROUP })],
  });
  const accountId = await connect();
  await sync(accountId, { mode: "group", groupId: 5, groupPath: "acme" });

  const row = await prisma.gitLabIssue.findFirstOrThrow();
  assert.equal(row.epicId, 972);
  assert.equal(row.epicIid, 586);
  assert.equal(row.epicGroupId, 17);
  assert.equal(row.epicTitle, "Router HA");
});

test("a group read picks up subgroups but not a same-prefixed sibling", async () => {
  mockGitLab({
    groupIssues: [groupIssue(1, "acme/web"), groupIssue(2, "acme/infra/tf")],
  });
  const accountId = await connect();
  await sync(accountId, { mode: "group", groupId: 5, groupPath: "acme" });

  // A sibling group whose name merely starts the same must not be swept in.
  await prisma.gitLabIssue.create({
    data: {
      accountId,
      projectId: 99,
      projectPath: "acme-legacy/old",
      issueIid: 7,
      title: "Legacy",
      state: "opened",
      url: `${SELF_HOSTED}/acme-legacy/old/-/issues/7`,
    },
  });

  const res = await readIssues({ accountId, groupPath: "acme", state: "all" });
  assert.deepEqual(
    (await res.json()).map((i: { projectPath: string }) => i.projectPath).sort(),
    ["acme/infra/tf", "acme/web"],
  );
});

test("epics sync under the group that owns them, not the one queried", async () => {
  mockGitLab({
    epics: [
      fakeEpic({
        id: 900,
        iid: 12,
        group_id: 6,
        title: "Ship the thing",
        description: "The goal text",
        references: { full: "acme/infra&12" },
      }),
      fakeEpic({ id: 901, iid: 4, group_id: 5, state: "closed" }),
    ],
  });
  const accountId = await connect();

  const res = await sync(accountId, {
    mode: "epics",
    groupId: 5,
    groupPath: "acme",
  });
  assert.equal((await res.json()).synced, 2);

  const descendant = await prisma.gitLabEpic.findFirstOrThrow({
    where: { epicId: 900 },
  });
  assert.equal(descendant.groupPath, "acme/infra");
  assert.equal(descendant.groupId, 6);
  assert.equal(descendant.body, "The goal text");

  // Reading the parent group still surfaces the descendant's epic.
  const listed = await epicsRoute(
    new NextRequest(
      `http://test/api/gitlab/epics?accountId=${accountId}&groupId=5&groupPath=acme&state=all`,
    ),
  );
  const epics = await listed.json();
  assert.equal(epics.length, 2);
  // Open work first: "closed" would win an ascending sort on the literals.
  assert.equal(epics[0].state, "opened");
});

test("an epic's issues cache against its global id, across projects", async () => {
  mockGitLab({
    epics: [fakeEpic({ id: 900, iid: 12, group_id: 6 })],
    epicIssues: {
      12: [
        groupIssue(41, "acme/web", { epic: { id: 900, iid: 12, title: "Epic 12", group_id: 6 } }),
        groupIssue(42, "acme/infra/tf", { epic: { id: 900, iid: 12, title: "Epic 12", group_id: 6 } }),
      ],
    },
  });
  const accountId = await connect();

  const res = await sync(accountId, {
    mode: "epic-issues",
    groupId: 6,
    epicIid: 12,
  });
  assert.equal((await res.json()).synced, 2);

  const read = await readIssues({
    accountId,
    epicId: "900",
    state: "all",
  });
  const rows = await read.json();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r: { projectPath: string }) => r.projectPath).sort(),
    ["acme/infra/tf", "acme/web"],
  );
});

test("a sync body with no mode is still a project sync", async () => {
  mockGitLab({ issues: [fakeIssue({ iid: 1 })] });
  const accountId = await connect();
  const res = await sync(accountId, { projectId: 12, projectPath: "acme/web" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).synced, 1);
});

test("reading issues with no scope at all is a 400", async () => {
  mockGitLab();
  const accountId = await connect();
  const res = await readIssues({ accountId, state: "all" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /projectId.*groupPath.*epicId/s);
});

// --- retrying a flaky transport --------------------------------------------

test("a transient DNS failure is retried rather than surfaced", async () => {
  // Two refusals then success — the shape of the network this was built on,
  // where getaddrinfo returned REFUSED for roughly three of every five lookups.
  mockGitLab();
  const good = global.fetch;
  let attempts = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (++attempts <= 2) {
      throw new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("getaddrinfo ENOTFOUND gitlab.acme.dev"),
          { code: "ENOTFOUND" },
        ),
      });
    }
    return good(input, init);
  }) as typeof fetch;

  const accountId = await connect();
  assert.equal(attempts, 3, "should have retried twice before succeeding");
  const account = await prisma.connectedAccount.findUniqueOrThrow({
    where: { id: accountId },
  });
  assert.equal(account.status, "connected");
});

test("a certificate failure is not retried — it cannot fix itself", async () => {
  let attempts = 0;
  global.fetch = (async () => {
    attempts++;
    throw new TypeError("fetch failed", {
      cause: Object.assign(
        new Error("self-signed certificate in certificate chain"),
        { code: "SELF_SIGNED_CERT_IN_CHAIN" },
      ),
    });
  }) as typeof fetch;

  const res = await addServerWith({
    baseUrl: SELF_HOSTED,
    label: "Acme",
    pat: "glpat-x",
  });
  assert.equal(res.status, 500);
  assert.equal(attempts, 1, "a permanent failure should be reported at once");
  assert.match((await res.json()).error, /NODE_EXTRA_CA_CERTS/);
});

// --- boards, pasted as a URL -----------------------------------------------

/** An issue in the shape the GraphQL board query returns. */
function gqlIssue(
  iid: number,
  path: string,
  status: string | null,
  over: Partial<GqlIssue> = {},
): GqlIssue {
  return {
    iid: String(iid),
    title: `Issue ${iid}`,
    description: null,
    state: "opened",
    webUrl: `${SELF_HOSTED}/${path}/-/issues/${iid}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    closedAt: null,
    reference: `${path}#${iid}`,
    projectId: path.length,
    status: status ? { name: status } : null,
    milestone: { title: MILESTONE },
    epic: null,
    labels: { nodes: [] },
    author: { username: "jane" },
    assignees: { nodes: [] },
    ...over,
  };
}

const MILESTONE = "Feedback Round (Aug 2026)";
const BOARD_URL = `${SELF_HOSTED}/groups/acme/-/boards/151?milestone_title=${encodeURIComponent(MILESTONE)}`;

/** The board that motivated this: columns are work-item statuses, not labels. */
const BOARD = {
  name: "DM Temp: Feedback",
  milestone: MILESTONE,
  columns: [
    { title: "Closed", listType: "closed", position: null },
    { title: "To do", listType: "status", position: 0 },
    { title: "In progress", listType: "status", position: 1 },
    { title: "Ready for Review", listType: "status", position: 2 },
    { title: "Released", listType: "status", position: 3 },
  ],
  issues: [
    gqlIssue(1, "acme/web", "To do"),
    gqlIssue(2, "acme/infra/tf", "Ready for Review"),
    gqlIssue(3, "acme/web", "In progress"),
    gqlIssue(4, "acme/web", "Released", { state: "closed" as const }),
    gqlIssue(5, "acme/web", null),
  ],
};

const resolve = (accountId: string, url: string) =>
  resolveRoute(
    new NextRequest(
      `http://test/api/gitlab/accounts/${accountId}/resolve?url=${encodeURIComponent(url)}`,
    ),
    { params: Promise.resolve({ accountId }) },
  );

test("a pasted board URL resolves to its columns, in board order", async () => {
  mockGitLab({ board: BOARD });
  const accountId = await connect();

  const res = await resolve(accountId, BOARD_URL);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.label, `board #151 in acme, milestone "${MILESTONE}"`);
  assert.equal(body.board.name, "DM Temp: Feedback");
  assert.equal(body.board.owner, "group");
  // The closed pseudo-column is GitLab's own, not the team's workflow.
  assert.deepEqual(
    body.board.columns.map((c: { title: string }) => c.title),
    ["To do", "In progress", "Ready for Review", "Released"],
  );
});

test("a board sync keeps the column each issue sat in", async () => {
  mockGitLab({ board: BOARD });
  const accountId = await connect();

  const res = await sync(accountId, {
    mode: "board",
    ownerPath: "acme",
    owner: "group",
    boardId: 151,
    milestoneTitle: MILESTONE,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).synced, 5);

  const rows = await prisma.gitLabIssue.findMany({ orderBy: { issueIid: "asc" } });
  assert.deepEqual(
    rows.map((r) => r.boardStatus),
    ["To do", "Ready for Review", "In progress", "Released", null],
  );
});

// The whole point of reading the board: an issue in "Ready for Review" should
// land in review, not in the backlog every open issue would otherwise get.
test("board columns map onto kanban statuses, not open/closed", async () => {
  mockGitLab({ board: BOARD });
  const accountId = await connect();
  await sync(accountId, {
    mode: "board",
    ownerPath: "acme",
    owner: "group",
    boardId: 151,
    milestoneTitle: MILESTONE,
  });

  const res = await readIssues({
    accountId,
    groupPath: "acme",
    milestone: MILESTONE,
    state: "all",
  });
  const issues = await res.json();
  const byIid = Object.fromEntries(
    issues.map((i: { issueIid: number; suggestedStatus: string }) => [
      i.issueIid,
      i.suggestedStatus,
    ]),
  );
  assert.deepEqual(byIid, {
    1: "todo",
    2: "in_review",
    3: "in_progress",
    // "Released" has to reach done; it used to fall through to backlog.
    4: "done",
    // No column at all falls back to the open/closed reading.
    5: "backlog",
  });
});

test("the milestone in the URL narrows the read", async () => {
  mockGitLab({ board: BOARD });
  const accountId = await connect();
  await sync(accountId, {
    mode: "board",
    ownerPath: "acme",
    owner: "group",
    boardId: 151,
    milestoneTitle: MILESTONE,
  });
  // An issue in the same group but a different milestone must stay out.
  await prisma.gitLabIssue.create({
    data: {
      accountId,
      projectId: 999,
      projectPath: "acme/web",
      issueIid: 77,
      title: "Other milestone",
      state: "opened",
      url: `${SELF_HOSTED}/acme/web/-/issues/77`,
      milestone: "Some other round",
    },
  });

  const res = await readIssues({
    accountId,
    groupPath: "acme",
    milestone: MILESTONE,
    state: "all",
  });
  const iids = (await res.json()).map((i: { issueIid: number }) => i.issueIid);
  assert.equal(iids.includes(77), false);
  assert.equal(iids.length, 5);
});

test("a board the token cannot see is reported, not silently empty", async () => {
  mockGitLab({ board: null });
  const accountId = await connect();
  const res = await resolve(accountId, BOARD_URL);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Board 151 not found/);
});

test("a URL that is not GitLab-shaped is a 400", async () => {
  mockGitLab();
  const accountId = await connect();
  const res = await resolve(accountId, "not a url at all");
  assert.equal(res.status, 400);
});

test("an epic URL resolves without needing a board", async () => {
  mockGitLab();
  const accountId = await connect();
  const res = await resolve(accountId, `${SELF_HOSTED}/groups/acme/-/epics/12`);
  const body = await res.json();
  assert.equal(body.label, "epic &12 in acme");
  assert.deepEqual(body.ref, { kind: "epic", groupPath: "acme", epicIid: 12 });
});

// `civo/dashboard` is a subgroup on a real instance, so a bare path has to be
// asked about rather than assumed to be a project.
test("an ambiguous bare path is resolved against the instance", async () => {
  mockGitLab({ projects: [{ id: 12, path_with_namespace: "acme/web" }] });
  const accountId = await connect();

  const asProject = await resolve(accountId, `${SELF_HOSTED}/acme/web`);
  assert.deepEqual((await asProject.json()).ref, {
    kind: "project",
    projectPath: "acme/web",
  });

  const asGroup = await resolve(accountId, `${SELF_HOSTED}/acme/infra`);
  assert.deepEqual((await asGroup.json()).ref, {
    kind: "group",
    groupPath: "acme/infra",
  });
});
