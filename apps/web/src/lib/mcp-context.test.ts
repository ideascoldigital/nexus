import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";

// Env setup must stay above the @nexux/db import — the client is built (and
// migrated) at module load.
import "../app/api/routes.test-setup";
import { prisma } from "@nexux/db";

import { createMcpContext, resolveEndpointArg, sandboxRunsOn } from "./mcp-context";

/**
 * The host half of the control surface: real rows in, the package's shapes
 * out. The interesting behaviour is what the mapping decides — what counts as
 * blocked, what counts as idle, and what a token can see at all.
 */

const ctx = createMcpContext();

let projectId: string;
let otherWorkspaceProjectId: string;
let sandboxId: string;

before(async () => {
  const [mine, theirs] = await Promise.all([
    prisma.workspace.upsert({
      where: { id: "ws-default" },
      update: {},
      create: { id: "ws-default", name: "Mine" },
    }),
    prisma.workspace.upsert({
      where: { id: "ws-mcp-theirs" },
      update: {},
      create: { id: "ws-mcp-theirs", name: "Theirs" },
    }),
  ]);

  const [project, other] = await Promise.all([
    prisma.project.create({ data: { name: "Mine", workspaceId: mine.id } }),
    prisma.project.create({ data: { name: "Theirs", workspaceId: theirs.id } }),
  ]);
  projectId = project.id;
  otherWorkspaceProjectId = other.id;

  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "box",
      status: "running",
      provider: "local",
      region: "local",
      size: "local",
      workDir: "/opt/nexux/app",
    },
  });
  sandboxId = sandbox.id;
});

beforeEach(async () => {
  await prisma.sandboxTask.deleteMany({});
});

const makeTask = (over: Record<string, unknown> = {}) =>
  prisma.sandboxTask.create({
    data: {
      sandboxId,
      prompt: "add login",
      workDir: "/opt/nexux/app",
      status: "running",
      ...over,
    },
  });

// --- what a token can see ----------------------------------------------------

test("only the default workspace's projects are listed", async () => {
  // An MCP request carries a token, not a cookie, so there is no active
  // workspace to read — the surface answers for the default one. A project in
  // another workspace must not leak through it.
  const projects = await ctx.listProjects();
  const ids = projects.map((p) => p.id);
  assert.ok(ids.includes(projectId));
  assert.ok(!ids.includes(otherWorkspaceProjectId));
});

test("a task in another workspace is not readable by id", async () => {
  const otherSandbox = await prisma.sandbox.create({
    data: {
      projectId: otherWorkspaceProjectId,
      name: "theirs",
      status: "running",
      provider: "local",
      region: "local",
      size: "local",
      workDir: "/opt/nexux/app",
    },
  });
  const task = await prisma.sandboxTask.create({
    data: {
      sandboxId: otherSandbox.id,
      prompt: "secret",
      workDir: "/opt/nexux/app",
      status: "running",
    },
  });

  // Guessing an id must not be a way around the workspace boundary.
  assert.equal(await ctx.getTask(task.id), null);
  assert.equal(await ctx.getTaskLogs(task.id), null);
});

// --- activity ----------------------------------------------------------------

test("a run waiting on an answer is blocked, not running", async () => {
  // needs_input is a phase, not a column; a blocked run holds a slot and looks
  // busy while nothing at all happens in it.
  await makeTask({ status: "running", phase: "needs_input" });
  const activity = await ctx.getActivity();

  assert.equal(activity.blocked.length, 1);
  assert.equal(activity.running.length, 0);
  assert.equal(activity.blocked[0].needsInput, true);
});

test("running, queued and finished runs land in their own buckets", async () => {
  await makeTask({ status: "running", prompt: "a" });
  await makeTask({ status: "queued", prompt: "b" });
  await makeTask({
    status: "completed",
    prompt: "c",
    finishedAt: new Date(),
  });

  const activity = await ctx.getActivity();
  assert.deepEqual(
    activity.running.map((t) => t.prompt),
    ["a"],
  );
  assert.deepEqual(
    activity.queued.map((t) => t.prompt),
    ["b"],
  );
  assert.deepEqual(
    activity.recentlyFinished.map((t) => t.prompt),
    ["c"],
  );
});

test("blocked runs come oldest first", async () => {
  // Recency would bury the thing that has been waiting longest, which is
  // exactly the run a person needs to reach.
  const old = await makeTask({ status: "running", phase: "needs_input", prompt: "old" });
  const recent = await makeTask({ status: "running", phase: "needs_input", prompt: "new" });
  await prisma.sandboxTask.update({
    where: { id: old.id },
    data: { updatedAt: new Date("2026-08-01T00:00:00Z") },
  });
  await prisma.sandboxTask.update({
    where: { id: recent.id },
    data: { updatedAt: new Date("2026-08-13T00:00:00Z") },
  });

  const activity = await ctx.getActivity();
  assert.deepEqual(
    activity.blocked.map((t) => t.prompt),
    ["old", "new"],
  );
});

test("a sandbox running a task is not offered as idle", async () => {
  await makeTask({ status: "running" });
  const activity = await ctx.getActivity();
  assert.deepEqual(activity.idleSandboxes, []);
});

test("a sandbox with nothing running is idle", async () => {
  const activity = await ctx.getActivity();
  assert.deepEqual(
    activity.idleSandboxes.map((s) => s.id),
    [sandboxId],
  );
});

// --- tasks -------------------------------------------------------------------

test("a task carries the project it belongs to", async () => {
  const task = await makeTask();
  const summary = await ctx.getTask(task.id);
  assert.equal(summary?.projectId, projectId, "resolved through its sandbox");
  assert.equal(summary?.sandboxId, sandboxId);
});

test("an unknown task id is null rather than a throw", async () => {
  assert.equal(await ctx.getTask("nope"), null);
  assert.equal(await ctx.getTaskLogs("nope"), null);
});

test("logs return the tail, not the whole history", async () => {
  const task = await makeTask({
    log: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"),
  });
  const tail = await ctx.getTaskLogs(task.id, 10);
  const lines = tail!.split("\n");
  assert.equal(lines.length, 10);
  assert.equal(lines.at(-1), "line 499");
});

test("a log shorter than the tail is returned whole", async () => {
  const task = await makeTask({ log: "one\ntwo" });
  assert.equal(await ctx.getTaskLogs(task.id, 100), "one\ntwo");
});

// --- sandboxes ---------------------------------------------------------------

test("sandboxes are listed for their project", async () => {
  const sandboxes = await ctx.listSandboxes(projectId);
  assert.deepEqual(
    sandboxes.map((s) => s.id),
    [sandboxId],
  );
});

test("another workspace's project reports no sandboxes", async () => {
  assert.deepEqual(await ctx.listSandboxes(otherWorkspaceProjectId), []);
});

test("launching into another workspace's project is refused", async () => {
  // The check happens before anything is provisioned, so this cannot spend
  // money on behalf of a project the token cannot see.
  await assert.rejects(
    () => ctx.launchSandbox({ projectId: otherWorkspaceProjectId }),
    /Project not found/,
  );
});

test("an unknown provider is refused before provisioning", async () => {
  await assert.rejects(
    () => ctx.launchSandbox({ projectId, provider: "gcp" }),
    /civo, aws, local/,
  );
});

test("powering another workspace's sandbox is refused", async () => {
  const otherSandbox = await prisma.sandbox.create({
    data: {
      projectId: otherWorkspaceProjectId,
      name: "theirs",
      status: "running",
      provider: "local",
      region: "local",
      size: "local",
      workDir: "/opt/nexux/app",
    },
  });
  await assert.rejects(
    () => ctx.powerSandbox(otherSandbox.id, "pause"),
    /Sandbox not found/,
  );
});

// --- where a sandbox runs (spec 26) -----------------------------------------

test("a sandbox says where it runs", () => {
  assert.equal(sandboxRunsOn({ provider: "local", region: "local", dockerHost: null }), "this machine");
  assert.equal(sandboxRunsOn({ provider: "local", region: "devbox", dockerHost: "ssh://devbox" }), "devbox");
  assert.equal(sandboxRunsOn({ provider: "civo", region: "lon1", dockerHost: null }), "civo lon1");
});

test("Docker endpoints are listed with whether a sandbox would work there", async () => {
  const ready = await prisma.dockerEndpoint.create({
    data: { name: "mcp-ep-ready", host: "ssh://mcp-ready", sandboxCheck: { status: "ok" } },
  });
  const unchecked = await prisma.dockerEndpoint.create({
    data: { name: "mcp-ep-new", host: "ssh://mcp-new" },
  });
  try {
    const list = await ctx.listDockerEndpoints();
    assert.equal(list.find((e) => e.id === ready.id)?.sandboxReady, true);
    assert.equal(list.find((e) => e.id === unchecked.id)?.sandboxReady, null);
    // By name or id, "this-machine" is explicit, omitted is the saved choice.
    assert.equal(await resolveEndpointArg("mcp-ep-ready"), ready.id);
    assert.equal(await resolveEndpointArg(ready.id), ready.id);
    assert.equal(await resolveEndpointArg("this-machine"), null);
    assert.equal(await resolveEndpointArg(undefined), undefined);
    await assert.rejects(() => resolveEndpointArg("nope"), /No Docker endpoint "nope"/);
  } finally {
    await prisma.dockerEndpoint.deleteMany({ where: { id: { in: [ready.id, unchecked.id] } } });
  }
});

test("listed sandboxes carry runsOn", async () => {
  const [s] = await ctx.listSandboxes(projectId);
  assert.equal(typeof s.runsOn, "string");
  assert.ok("dockerEndpointId" in s);
});

// --- creating projects (spec 39) ----------------------------------------------

test("a project from Git URLs gets a folder for each repo, so it can be cloned", async () => {
  const created = await ctx.createProject({
    name: "Acme Shop",
    repositories: [
      { name: "api", repoUrl: "https://github.com/acme/api.git" },
      { name: "Web App", repoUrl: "https://github.com/acme/web.git", localPath: "/tmp/acme-web" },
    ],
  });
  assert.equal(created.name, "Acme Shop");
  const [api, web] = created.repositories;
  assert.equal(api.isMain, true);
  assert.match(api.localPath ?? "", /acme-shop\/api$/);
  assert.equal(web.localPath, "/tmp/acme-web");
  assert.equal(api.cloneStatus, "pending");
  assert.ok(created.workspacePath?.endsWith("acme-shop"));
  assert.deepEqual((await ctx.getProject(created.id))?.repositories.length, 2);
});

test("an unknown git credential is refused as the caller's mistake", async () => {
  await assert.rejects(
    ctx.createProject({ name: "X", repositories: [{ name: "a", repoUrl: "https://x/a.git", gitCredentialId: "nope" }] }),
    /Not a saved git credential/,
  );
});

test("git credentials are listed by name, never with their secret", async () => {
  const cred = await prisma.cloudCredential.create({
    data: { name: "Work GitHub", provider: "github", data: { token: "ghp_secret" } },
  });
  await prisma.cloudCredential.create({ data: { name: "Civo", provider: "civo", data: { token: "c" } } });
  const listed = await ctx.listGitCredentials();
  assert.deepEqual(listed.find((c) => c.id === cred.id), { id: cred.id, name: "Work GitHub", provider: "github" });
  assert.ok(!listed.some((c) => c.provider === "civo"));
  assert.ok(!JSON.stringify(listed).includes("ghp_secret"));
});

test("another workspace's project cannot be read, cloned or detected", async () => {
  assert.equal(await ctx.getProject(otherWorkspaceProjectId), null);
  await assert.rejects(ctx.cloneRepositories(otherWorkspaceProjectId), /Project not found/);
  await assert.rejects(ctx.detectStack(otherWorkspaceProjectId), /Project not found/);
});

test("detecting skips repos that are not checked out", async () => {
  const p = await ctx.createProject({ name: "Pending", repositories: [{ name: "a", repoUrl: "https://x/a.git" }] });
  const res = (await ctx.detectStack(p.id)) as { repositories: { repository: string; skipped?: string }[] };
  assert.deepEqual(res.repositories, [{ repository: "a", skipped: "not checked out (pending)" }]);
});

test("from a chat, a cloud sandbox waits for confirmation and never launches on its own", async () => {
  const asked: string[] = [];
  const chat = createMcpContext({
    confirm: (a) => {
      asked.push(a.summary);
      return "act_abc123";
    },
  });
  await assert.rejects(chat.launchSandbox({ projectId, provider: "civo" }), /Needs the user's confirmation[\s\S]*act_abc123/);
  assert.match(asked[0] ?? "", /civo sandbox for "Mine"/);
  assert.equal(await prisma.sandbox.count({ where: { projectId, provider: "civo", status: "provisioning" } }), 0);
});
