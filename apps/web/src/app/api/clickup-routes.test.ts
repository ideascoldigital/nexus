import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as readConfig, PUT as putConfig } from "./clickup/config/route";
import { GET as oauthStart } from "./clickup/oauth/start/route";
import { GET as oauthCallback } from "./clickup/oauth/callback/route";
import { GET as listAccounts } from "./clickup/accounts/route";
import { DELETE as deleteAccount, PATCH as revalidateAccount } from "./clickup/accounts/[accountId]/route";
import { GET as teamsRoute } from "./clickup/accounts/[accountId]/teams/route";
import { POST as syncRoute } from "./clickup/accounts/[accountId]/sync/route";
import { GET as tasksRoute } from "./clickup/tasks/route";
import { POST as importRoute } from "./projects/[projectId]/clickup-import/route";
import {
  DELETE as unlinkRoute,
  GET as linkedRoute,
  POST as linkRoute,
} from "./projects/[projectId]/features/[featureId]/clickup-tasks/route";

// The OAuth flow is the one place a mistyped state or a leaked token turns
// into someone else's ClickUp account being attached to this install — these
// drive the real handlers end to end with ClickUp itself faked at the fetch
// boundary.

const realFetch = global.fetch;

type FakeUser = {
  id: number;
  username: string;
  email: string;
  color: string | null;
  profilePicture: string | null;
  initials: string | null;
};

const fakeUser: FakeUser = {
  id: 42,
  username: "Jane",
  email: "jane@example.com",
  color: "#123456",
  profilePicture: "https://clickup.com/avatar.jpg",
  initials: "JD",
};

type FakeTask = {
  id: string;
  name: string;
  description: string | null;
  status: { status: string; type: string } | null;
  priority: { priority: string } | null;
  due_date: string | null;
  url: string;
  assignees: { username: string }[];
  tags: { name: string }[];
  parent: string | null;
  list: { id: string; name: string } | null;
  folder: { id: string } | null;
  space: { id: string } | null;
};

const fakeTask = (over: Partial<FakeTask> & { id: string }): FakeTask => ({
  name: `Task ${over.id}`,
  description: null,
  status: { status: "to do", type: "open" },
  priority: null,
  due_date: null,
  url: `https://app.clickup.com/t/${over.id}`,
  assignees: [],
  tags: [],
  parent: null,
  list: { id: "l1", name: "Sprint 1" },
  folder: null,
  space: { id: "s1" },
  ...over,
});

/** Fake ClickUp: token exchange + identity + task endpoints. */
function mockClickUp(
  opts: {
    tokenOk?: boolean;
    userOk?: boolean;
    teamsOk?: boolean;
    user?: FakeUser;
    tasks?: FakeTask[];
  } = {}
) {
  const {
    tokenOk = true,
    userOk = true,
    teamsOk = true,
    user = fakeUser,
    tasks = [],
  } = opts;
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return tokenOk
        ? Response.json({ access_token: "cu_access_token" })
        : Response.json({ err: "OAUTH_019" }, { status: 400 });
    }
    if (url.endsWith("/user")) {
      return userOk
        ? Response.json({ user })
        : Response.json({ err: "Token invalid" }, { status: 401 });
    }
    if (url.endsWith("/team")) {
      return teamsOk
        ? Response.json({
            teams: [{ id: "t1", name: "Acme", color: null, avatar: null }],
          })
        : Response.json({ err: "Team(s) not authorized" }, { status: 401 });
    }
    if (url.includes("/task?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json({ tasks: page === 0 ? tasks : [], last_page: true });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

before(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.oAuthState.deleteMany({});
  await prisma.connectedAccount.deleteMany({ where: { providerType: "clickup" } });
  await prisma.settings.deleteMany({ where: { key: { startsWith: "clickup_" } } });
});

afterEach(() => {
  global.fetch = realFetch;
});

const configure = () =>
  putConfig(
    new NextRequest("http://test/api/clickup/config", {
      method: "PUT",
      body: JSON.stringify({ clientId: "cid_123", clientSecret: "sec_456" }),
      headers: { "Content-Type": "application/json" },
    })
  );

const getConfig = () =>
  readConfig(new NextRequest("http://localhost:3000/api/clickup/config"));

const start = () =>
  oauthStart(new NextRequest("http://localhost:3000/api/clickup/oauth/start"));

const CALLBACK = "http://localhost:3000/api/clickup/oauth/callback";

const callback = (params: Record<string, string>) => {
  const url = new URL("http://localhost:3000/api/clickup/oauth/callback");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return oauthCallback(new NextRequest(url));
};

/** Run /oauth/start and pull the state nonce out of the redirect. */
async function startAndGetState(): Promise<string> {
  const res = await start();
  const location = new URL(res.headers.get("location")!);
  return location.searchParams.get("state")!;
}

// --- app config -------------------------------------------------------------

test("config starts unconfigured", async () => {
  const res = await getConfig();
  assert.deepEqual(await res.json(), {
    configured: false,
    clientId: null,
    callbackUrl: CALLBACK,
  });
});

test("config rejects missing fields", async () => {
  const res = await putConfig(
    new NextRequest("http://test/api/clickup/config", {
      method: "PUT",
      body: JSON.stringify({ clientId: "only-id" }),
      headers: { "Content-Type": "application/json" },
    })
  );
  assert.equal(res.status, 400);
});

test("config saves and reports the client id but never the secret", async () => {
  await configure();
  const res = await getConfig();
  const json = await res.json();
  assert.deepEqual(json, {
    configured: true,
    clientId: "cid_123",
    callbackUrl: CALLBACK,
  });
  assert.equal(JSON.stringify(json).includes("sec_456"), false);
});

// --- /oauth/start -----------------------------------------------------------

test("start without an app configured bounces back to settings with an error", async () => {
  const res = await start();
  const location = res.headers.get("location")!;
  assert.match(location, /\/settings\?/);
  assert.match(location, /clickup_error=/);
});

test("start redirects to ClickUp with client id, callback url and a stored state", async () => {
  await configure();
  const res = await start();
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.origin + location.pathname, "https://app.clickup.com/api");
  assert.equal(location.searchParams.get("client_id"), "cid_123");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "http://localhost:3000/api/clickup/oauth/callback"
  );
  const state = location.searchParams.get("state")!;
  const row = await prisma.oAuthState.findUnique({ where: { state } });
  assert.equal(row?.provider, "clickup");
});

// Regression: the container binds to 0.0.0.0, so `req.nextUrl.origin` used to
// make the redirect_uri `http://0.0.0.0:3030/...` — a URL that resolves nowhere
// and never matches what the Settings card told you to register. The deployed
// origin must come from NEXUX_WEB_ORIGIN, and Settings must quote that same
// value, or the round-trip is unfixable by the operator.
test("the deployed origin drives redirect_uri, and Settings quotes the same URL", async () => {
  const saved = process.env.NEXUX_WEB_ORIGIN;
  process.env.NEXUX_WEB_ORIGIN = "http://100.64.0.20:3030";
  try {
    await configure();
    const expected = "http://100.64.0.20:3030/api/clickup/oauth/callback";

    const location = new URL((await start()).headers.get("location")!);
    assert.equal(location.searchParams.get("redirect_uri"), expected);

    const { callbackUrl } = await (await getConfig()).json();
    assert.equal(callbackUrl, expected);
  } finally {
    if (saved === undefined) delete process.env.NEXUX_WEB_ORIGIN;
    else process.env.NEXUX_WEB_ORIGIN = saved;
  }
});

// --- /oauth/callback --------------------------------------------------------

test("callback with an unknown state is refused", async () => {
  mockClickUp();
  const res = await callback({ code: "abc", state: "forged" });
  assert.match(res.headers.get("location")!, /clickup_error=Invalid\+OAuth\+state/);
  assert.equal(await prisma.connectedAccount.count({ where: { providerType: "clickup" } }), 0);
});

test("callback without a state is refused", async () => {
  const res = await callback({ code: "abc" });
  assert.match(res.headers.get("location")!, /clickup_error=/);
});

test("a state is single-use — the second round-trip with it fails", async () => {
  await configure();
  mockClickUp();
  const state = await startAndGetState();
  await callback({ code: "abc", state });
  const res = await callback({ code: "abc", state });
  assert.match(res.headers.get("location")!, /clickup_error=Invalid\+OAuth\+state/);
});

test("an expired state is refused", async () => {
  await configure();
  const state = await startAndGetState();
  await prisma.oAuthState.update({
    where: { state },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const res = await callback({ code: "abc", state });
  assert.match(res.headers.get("location")!, /clickup_error=OAuth\+state\+expired/);
});

test("cancelling on the consent screen surfaces as an error, not a crash", async () => {
  await configure();
  const state = await startAndGetState();
  const res = await callback({ state });
  assert.match(res.headers.get("location")!, /clickup_error=Authorization\+was\+cancelled/);
});

test("a full round-trip stores the account with its token and identity", async () => {
  await configure();
  mockClickUp();
  const state = await startAndGetState();
  const res = await callback({ code: "auth-code", state });
  assert.match(res.headers.get("location")!, /clickup=connected/);

  const account = await prisma.connectedAccount.findFirst({
    where: { providerType: "clickup" },
    include: { oauthTokens: true },
  });
  assert.equal(account?.authMode, "oauth");
  assert.equal(account?.status, "connected");
  assert.equal(account?.label, "Jane");
  assert.equal((account?.metadata as { userId: number }).userId, 42);
  assert.deepEqual((account?.metadata as { teams: unknown[] }).teams, [
    { id: "t1", name: "Acme", color: null, avatar: null },
  ]);
  assert.equal(account?.oauthTokens[0]?.accessToken, "cu_access_token");
});

test("reconnecting the same ClickUp user updates the account instead of duplicating it", async () => {
  await configure();
  mockClickUp();
  await callback({ code: "c1", state: await startAndGetState() });
  await callback({ code: "c2", state: await startAndGetState() });
  assert.equal(
    await prisma.connectedAccount.count({ where: { providerType: "clickup" } }),
    1
  );
  assert.equal(await prisma.oAuthToken.count(), 1);
});

test("a failed token exchange lands back in settings with ClickUp's error", async () => {
  await configure();
  mockClickUp({ tokenOk: false });
  const res = await callback({ code: "bad", state: await startAndGetState() });
  assert.match(res.headers.get("location")!, /clickup_error=OAUTH_019/);
});

test("a /team that fails during connect still yields a usable account", async () => {
  await configure();
  mockClickUp({ teamsOk: false });
  const res = await callback({ code: "auth-code", state: await startAndGetState() });

  // Connecting must still succeed — the token is what matters.
  assert.match(res.headers.get("location")!, /clickup=connected/);
  const account = await prisma.connectedAccount.findFirst({
    where: { providerType: "clickup" },
  });
  assert.equal(account?.status, "connected");
  assert.deepEqual((account?.metadata as { teams: unknown[] }).teams, []);

  // ...and the empty snapshot decides nothing: the picker asks /teams, which
  // reads live and recovers on its own. This is the whole point of D-54 —
  // before it, that `[]` was the workspace dropdown and stayed empty forever.
  mockClickUp();
  const teams = await teamsRoute(new NextRequest("http://localhost:3000/t"), {
    params: Promise.resolve({ accountId: account!.id }),
  });
  assert.equal(teams.status, 200);
  assert.deepEqual(await teams.json(), [
    { id: "t1", name: "Acme", color: null, avatar: null },
  ]);
});

test("listing workspaces surfaces a ClickUp failure instead of an empty list", async () => {
  const accountId = await connectedAccountId();
  mockClickUp({ teamsOk: false });
  const res = await teamsRoute(new NextRequest("http://localhost:3000/t"), {
    params: Promise.resolve({ accountId }),
  });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not authorized/);
});

// --- accounts ---------------------------------------------------------------

async function connectedAccountId(): Promise<string> {
  await configure();
  mockClickUp();
  await callback({ code: "c", state: await startAndGetState() });
  const account = await prisma.connectedAccount.findFirstOrThrow({
    where: { providerType: "clickup" },
  });
  return account.id;
}

test("listing accounts never includes tokens", async () => {
  await connectedAccountId();
  const res = await listAccounts();
  const body = JSON.stringify(await res.json());
  assert.equal(body.includes("cu_access_token"), false);
  assert.match(body, /Jane/);
});

test("revalidate flips a dead token to error and reports 401", async () => {
  const id = await connectedAccountId();
  mockClickUp({ userOk: false });
  const res = await revalidateAccount(
    new NextRequest(`http://test/api/clickup/accounts/${id}`, { method: "PATCH" }),
    { params: Promise.resolve({ accountId: id }) }
  );
  assert.equal(res.status, 401);
  const account = await prisma.connectedAccount.findUnique({ where: { id } });
  assert.equal(account?.status, "error");
});

test("revalidate of an unknown account is a 404", async () => {
  const res = await revalidateAccount(
    new NextRequest("http://test/api/clickup/accounts/nope", { method: "PATCH" }),
    { params: Promise.resolve({ accountId: "nope" }) }
  );
  assert.equal(res.status, 404);
});

// --- task sync + cache ------------------------------------------------------

const syncList = (accountId: string) =>
  syncRoute(
    new NextRequest(`http://test/api/clickup/accounts/${accountId}/sync`, {
      method: "POST",
      body: JSON.stringify({ teamId: "t1", listId: "l1" }),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ accountId }) }
  );

const localTasks = (accountId: string, extra: Record<string, string> = {}) => {
  const url = new URL("http://test/api/clickup/tasks");
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("listId", "l1");
  Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
  return tasksRoute(new NextRequest(url));
};

test("sync caches a list's tasks and a re-sync updates instead of duplicating", async () => {
  const accountId = await connectedAccountId();
  mockClickUp({ tasks: [fakeTask({ id: "a" }), fakeTask({ id: "b" })] });
  const res = await syncList(accountId);
  assert.deepEqual(await res.json(), { synced: 2, listId: "l1" });

  mockClickUp({ tasks: [fakeTask({ id: "a", name: "Renamed" })] });
  await syncList(accountId);
  const rows = await prisma.clickUpTask.findMany({ orderBy: { taskId: "asc" } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Renamed");
});

test("cached tasks hide closed ones unless asked, and search filters by name", async () => {
  const accountId = await connectedAccountId();
  mockClickUp({
    tasks: [
      fakeTask({ id: "open1", name: "Build login" }),
      fakeTask({ id: "closed1", name: "Old thing", status: { status: "closed", type: "closed" } }),
    ],
  });
  await syncList(accountId);

  const visible = await (await localTasks(accountId)).json();
  assert.deepEqual(visible.map((t: { taskId: string }) => t.taskId), ["open1"]);

  const all = await (await localTasks(accountId, { includeClosed: "true" })).json();
  assert.equal(all.length, 2);

  const found = await (await localTasks(accountId, { search: "login" })).json();
  assert.deepEqual(found.map((t: { name: string }) => t.name), ["Build login"]);
});

// --- import as features -----------------------------------------------------

let importProjectId: string;

async function importProject(): Promise<string> {
  if (importProjectId) return importProjectId;
  const workspace = await prisma.workspace.create({
    data: { id: "ws-clickup-test", name: "ClickUp" },
  });
  const project = await prisma.project.create({
    data: { name: "ClickUp", workspaceId: workspace.id },
  });
  importProjectId = project.id;
  return importProjectId;
}

const runImport = (projectId: string, body: unknown) =>
  importRoute(
    new NextRequest(`http://test/api/projects/${projectId}/clickup-import`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ projectId }) }
  );

test("import creates a phase, its features, and provenance links in one shot", async () => {
  const projectId = await importProject();
  const accountId = await connectedAccountId();
  mockClickUp({ tasks: [fakeTask({ id: "a" })] });
  await syncList(accountId);
  const cached = await prisma.clickUpTask.findFirstOrThrow();

  const res = await runImport(projectId, {
    phases: [
      {
        name: "Sprint 1",
        goal: "Ship the MVP",
        features: [
          {
            title: "Build login",
            description: "From ClickUp",
            priority: "high",
            status: "todo",
            clickUpTaskId: cached.id,
          },
          { title: "Manual extra", priority: "medium", status: "backlog" },
        ],
      },
    ],
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).featureCount, 2);

  const phase = await prisma.devPhase.findFirstOrThrow({ where: { projectId } });
  assert.equal(phase.name, "Sprint 1");
  const features = await prisma.feature.findMany({
    where: { projectId },
    orderBy: { title: "asc" },
    include: { featureClickUpTasks: true },
  });
  assert.equal(features.length, 2);
  assert.equal(features[0].devPhaseId, phase.id);
  assert.equal(features[0].status, "todo");
  assert.equal(features[0].featureClickUpTasks[0]?.taskId, cached.id);
  assert.equal(features[1].featureClickUpTasks.length, 0);
});

test("import without createPhase leaves features phaseless", async () => {
  const projectId = await importProject();
  const res = await runImport(projectId, {
    phases: [
      {
        name: "ignored",
        createPhase: false,
        features: [{ title: "Loose task", priority: "low", status: "backlog" }],
      },
    ],
  });
  assert.equal(res.status, 201);
  const feature = await prisma.feature.findFirstOrThrow({
    where: { projectId, title: "Loose task" },
  });
  assert.equal(feature.devPhaseId, null);
});

test("import refuses a status outside the kanban's vocabulary", async () => {
  const projectId = await importProject();
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

// --- feature ↔ task linking -------------------------------------------------

test("link, list and unlink a task on a feature", async () => {
  const projectId = await importProject();
  const accountId = await connectedAccountId();
  mockClickUp({ tasks: [fakeTask({ id: "a" })] });
  await syncList(accountId);
  const cached = await prisma.clickUpTask.findFirstOrThrow();
  const feature = await prisma.feature.create({
    data: { projectId, title: "Linkable" },
  });
  const routeParams = {
    params: Promise.resolve({ projectId, featureId: feature.id }),
  };

  const linkRes = await linkRoute(
    new NextRequest("http://test/link", {
      method: "POST",
      body: JSON.stringify({ taskId: cached.id }),
      headers: { "Content-Type": "application/json" },
    }),
    routeParams
  );
  assert.equal(linkRes.status, 201);

  const listed = await (
    await linkedRoute(new NextRequest("http://test/link"), routeParams)
  ).json();
  assert.equal(listed[0].task.taskId, "a");

  const unlinkRes = await unlinkRoute(
    new NextRequest(`http://test/link?taskId=${cached.id}`, { method: "DELETE" }),
    routeParams
  );
  assert.equal(unlinkRes.status, 200);
  assert.equal(await prisma.featureClickUpTask.count(), 0);
});

test("deleting an account cascades its token", async () => {
  const id = await connectedAccountId();
  const res = await deleteAccount(
    new NextRequest(`http://test/api/clickup/accounts/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ accountId: id }) }
  );
  assert.equal(res.status, 200);
  assert.equal(await prisma.connectedAccount.count({ where: { providerType: "clickup" } }), 0);
  assert.equal(await prisma.oAuthToken.count(), 0);
});
