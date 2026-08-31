import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as exportGet, POST as exportPost } from "./export/route";
import { open } from "@/lib/export/envelope";
import type { ExportDocument } from "@/lib/export/schema";

/** Values that must never appear in a secretless export. */
const ENV_SECRET = "pg://user:hunter2@db.internal/app";
const CRED_SECRET = "civo-token-SHOULD-NOT-LEAK";
const SETTING_SECRET = "sk-ant-SHOULD-NOT-LEAK";
const NODE_ENV_SECRET = "canvas-secret-SHOULD-NOT-LEAK";
const MCP_SECRET = "mcp-header-SHOULD-NOT-LEAK";

const PASS = "a passphrase long enough";

let projectId: string;
let otherProjectId: string;
let credentialId: string;
let repositoryId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-export-test", name: "Export" },
  });

  const credential = await prisma.cloudCredential.create({
    data: {
      workspaceId: workspace.id,
      name: "civo-main",
      provider: "civo",
      data: { token: CRED_SECRET },
    },
  });
  credentialId = credential.id;

  await prisma.settings.create({
    data: { key: "anthropic_api_key", value: SETTING_SECRET, provider: "anthropic" },
  });

  const project = await prisma.project.create({
    data: {
      name: "Metaphor",
      workspaceId: workspace.id,
      workspacePath: "/Users/dev/workspace/metaphor",
    },
  });
  projectId = project.id;

  const other = await prisma.project.create({
    data: {
      name: "Other",
      workspaceId: workspace.id,
      workspacePath: "/Users/dev/workspace/other",
    },
  });
  otherProjectId = other.id;

  const repo = await prisma.repository.create({
    data: {
      projectId,
      name: "web",
      isMain: true,
      repoUrl: "git@github.com:acme/web.git",
      localPath: "/Users/dev/workspace/metaphor/web",
      cloneStatus: "ready",
      setup: { create: { installCommand: "pnpm install", runCommand: "pnpm dev" } },
    },
  });
  repositoryId = repo.id;

  await prisma.projectEnvVar.create({
    data: { projectId, key: "DATABASE_URL", value: ENV_SECRET },
  });

  await prisma.stackNode.create({
    data: {
      projectId,
      kind: "repo",
      repositoryId,
      name: "web",
      runMode: "local",
      env: [{ key: "API_KEY", value: NODE_ENV_SECRET }],
      ports: [{ host: 3000, container: 3000 }],
    },
  });

  await prisma.sandboxConfig.create({
    data: {
      projectId,
      provider: "civo",
      credentialId,
      region: "NYC1",
      mcpServers: { ctx7: { type: "http", url: "https://x", headers: { auth: MCP_SECRET } } },
      llmCredentials: { create: [{ credentialId }] },
    },
  });

  const devPhase = await prisma.devPhase.create({
    data: { projectId, name: "MVP", order: 0 },
  });
  await prisma.feature.create({
    data: { projectId, devPhaseId: devPhase.id, title: "Login", order: 0 },
  });

  await prisma.taskSchedule.create({
    data: { projectId, prompt: "nightly", cron: "0 3 * * *", enabled: true },
  });

  // Layer 3 — machine state that must never be exported.
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "nexux-metaphor-1",
      status: "running",
      region: "NYC1",
      size: "g3.medium",
      instanceId: "civo-instance-SHOULD-NOT-LEAK",
      publicIp: "203.0.113.9",
      workDir: "/Users/dev/.nexux/tf/metaphor",
    },
  });
  await prisma.sandboxProcess.create({
    data: {
      sandboxId: sandbox.id,
      key: "repo-x",
      label: "web",
      command: "pnpm dev",
      cwd: "/opt/nexus/web",
      pid: 4242,
    },
  });
  await prisma.sandboxTask.create({
    data: { sandboxId: sandbox.id, prompt: "do a thing", workDir: "/opt/nexus/web" },
  });
  await prisma.embeddingIndex.create({
    data: {
      projectId,
      sourceType: "file",
      sourceId: "src/index.ts",
      contentHash: "abc",
      chunkCount: 3,
      provider: "ollama-nomic",
      dimensions: 768,
    },
  });
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

function getExport(query = "") {
  return exportGet(new NextRequest(`http://test/api/export${query}`));
}

function postExport(body: unknown) {
  return exportPost(
    new NextRequest("http://test/api/export", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

const docOf = async (res: Response) => (await res.json()) as ExportDocument;

test("GET exports every project with configuration intact", async () => {
  const res = await getExport();
  assert.equal(res.status, 200);
  const doc = await docOf(res);

  assert.equal(doc.meta.nexuxExportVersion, 1);
  assert.equal(doc.meta.includesSecrets, false);
  assert.equal(doc.projects.length, 2);

  const project = doc.projects.find((p) => p.id === projectId)!;
  assert.equal(project.name, "Metaphor");
  assert.equal(project.repositories[0].repoUrl, "git@github.com:acme/web.git");
  assert.equal(project.repositories[0].setup?.installCommand, "pnpm install");
  assert.equal(project.stack.nodes.length, 1);
  assert.equal(project.features.length, 1);
  assert.equal(project.devPhases.length, 1);
  // The feature's phase FK survives, so the kanban rebuilds on the far side.
  assert.equal(project.features[0].devPhaseId, project.devPhases[0].id);
});

test("template export keeps structure and drops the work product", async () => {
  const res = await getExport("?template=true");
  assert.equal(res.status, 200);
  const doc = await docOf(res);

  assert.equal(doc.meta.template, true);
  assert.equal(doc.meta.includesSecrets, false);
  assert.equal(doc.meta.includesConversations, false);

  const project = doc.projects.find((p) => p.id === projectId)!;
  // Structure survives…
  assert.ok(project.repositories.length > 0, "repositories travel");
  assert.ok(project.stack.nodes.length > 0, "stack travels");
  assert.ok(project.sandboxConfig, "sandbox config travels");
  assert.ok(project.envVars.length > 0, "env var keys travel");
  // …the work product does not.
  assert.equal(project.features.length, 0, "no features");
  assert.equal(project.devPhases.length, 0, "no dev phases");
  assert.equal(project.phases.length, 0, "no definition phases");
  assert.equal(project.document, null, "no document");
  assert.equal(project.schedules.length, 0, "no schedules");
  assert.equal(project.conversations.length, 0, "no conversations");
  // Env values stay behind even though the keys travel.
  assert.ok(project.envVars.every((v) => v.value === null));

  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /nexux-template-/);
});

test("template with conversations still excludes them", async () => {
  const doc = await docOf(
    await getExport("?template=true&includeConversations=true"),
  );
  assert.equal(doc.meta.includesConversations, false);
  const project = doc.projects.find((p) => p.id === projectId)!;
  assert.equal(project.conversations.length, 0);
});

test("POST refuses a template that asks for secrets", async () => {
  const res = await postExport({
    template: true,
    includeSecrets: true,
    passphrase: "a-long-enough-passphrase",
  });
  assert.equal(res.status, 400);
});

test("no plaintext secret appears anywhere in a secretless export", async () => {
  const serialised = JSON.stringify(await docOf(await getExport()));

  for (const secret of [ENV_SECRET, CRED_SECRET, SETTING_SECRET, NODE_ENV_SECRET, MCP_SECRET]) {
    assert.ok(
      !serialised.includes(secret),
      `secretless export leaked ${secret}`,
    );
  }
});

test("secretless export still carries env var keys and credential shells", async () => {
  const doc = await docOf(await getExport());
  const project = doc.projects.find((p) => p.id === projectId)!;

  // The key without the value is a checklist, not a hole.
  assert.equal(project.envVars.length, 1);
  assert.equal(project.envVars[0].key, "DATABASE_URL");
  assert.equal(project.envVars[0].value, null);

  // The credential's identity survives so SandboxConfig's FKs stay meaningful
  // — which of two tokens a project pinned is configuration (D-28).
  const cred = doc.credentials.find((c) => c.id === credentialId)!;
  assert.equal(cred.name, "civo-main");
  assert.equal(cred.provider, "civo");
  assert.equal(cred.data, null);
  assert.equal(project.sandboxConfig?.credentialId, credentialId);
  assert.deepEqual(project.sandboxConfig?.llmCredentialIds, [credentialId]);
});

test("Settings are omitted entirely without includeSecrets", async () => {
  const doc = await docOf(await getExport());
  assert.deepEqual(doc.settings, []);
});

test("layer 3 machine state is never exported", async () => {
  const serialised = JSON.stringify(await docOf(await getExport()));
  // Sandbox rows point at infrastructure the destination cannot manage.
  assert.ok(!serialised.includes("civo-instance-SHOULD-NOT-LEAK"));
  assert.ok(!serialised.includes("203.0.113.9"));
  assert.ok(!serialised.includes("nexux-metaphor-1"));
  // PIDs, run logs, and LanceDB bookkeeping whose tables do not travel.
  assert.ok(!serialised.includes("4242"));
  assert.ok(!serialised.includes("do a thing"));
  assert.ok(!serialised.includes("ollama-nomic"));
});

test("host paths are relativised to a computed pathRoot", async () => {
  const doc = await docOf(await getExport());
  assert.equal(doc.meta.pathRoot, "/Users/dev/workspace");

  const project = doc.projects.find((p) => p.id === projectId)!;
  assert.deepEqual(project.workspacePath, { root: "pathRoot", rel: "metaphor" });
  assert.deepEqual(project.repositories[0].localPath, {
    root: "pathRoot",
    rel: "metaphor/web",
  });
  // No absolute host path survives anywhere in the document.
  assert.ok(!JSON.stringify(doc).includes("/Users/dev/workspace/metaphor"));
});

test("an explicit pathRoot overrides the computed one", async () => {
  const doc = await docOf(await getExport("?pathRoot=/Users/dev"));
  assert.equal(doc.meta.pathRoot, "/Users/dev");
  const project = doc.projects.find((p) => p.id === projectId)!;
  assert.deepEqual(project.workspacePath, {
    root: "pathRoot",
    rel: "workspace/metaphor",
  });
});

test("scope=project exports only the named projects", async () => {
  const doc = await docOf(await getExport(`?scope=project&projectId=${projectId}`));
  assert.equal(doc.projects.length, 1);
  assert.equal(doc.projects[0].id, projectId);
  assert.deepEqual(doc.meta.scope, { kind: "project", projectIds: [projectId] });
  // The credential the config references still travels, or the FK dangles.
  assert.ok(doc.credentials.some((c) => c.id === credentialId));
});

test("scope=project without an id is a 400", async () => {
  const res = await getExport("?scope=project");
  assert.equal(res.status, 400);
});

test("conversations are excluded unless asked for", async () => {
  const conversation = await prisma.conversation.create({
    data: { projectId, sessionId: `s-${Date.now()}`, name: "chat" },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, role: "user", content: "hello there" },
  });

  const without = await docOf(await getExport());
  assert.equal(without.meta.includesConversations, false);
  assert.deepEqual(
    without.projects.find((p) => p.id === projectId)!.conversations,
    [],
  );

  const with_ = await docOf(await getExport("?includeConversations=true"));
  const project = with_.projects.find((p) => p.id === projectId)!;
  assert.equal(project.conversations.length, 1);
  assert.equal(project.conversations[0].messages[0].content, "hello there");

  await prisma.conversation.delete({ where: { id: conversation.id } });
});

test("GET refuses includeSecrets — a passphrase must not ride in a URL", async () => {
  const res = await getExport("?includeSecrets=true&passphrase=whatever");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /POST/);
});

test("POST with includeSecrets returns a sealed envelope carrying the secrets", async () => {
  const res = await postExport({ includeSecrets: true, passphrase: PASS });
  assert.equal(res.status, 200);

  const envelope = await res.json();
  assert.equal(envelope.encrypted, true);
  // Nothing readable on the wire.
  assert.ok(!JSON.stringify(envelope).includes(ENV_SECRET));
  assert.ok(!JSON.stringify(envelope).includes(CRED_SECRET));

  const doc = (await open(envelope, PASS)) as ExportDocument;
  assert.equal(doc.meta.includesSecrets, true);
  const project = doc.projects.find((p) => p.id === projectId)!;
  assert.equal(project.envVars[0].value, ENV_SECRET);
  assert.deepEqual(doc.credentials.find((c) => c.id === credentialId)!.data, {
    token: CRED_SECRET,
  });
  assert.ok(doc.settings.some((s) => s.value === SETTING_SECRET));
  // Canvas env and MCP headers follow the same rule as ProjectEnvVar.
  assert.ok(JSON.stringify(project.stack.nodes[0].env).includes(NODE_ENV_SECRET));
  assert.ok(JSON.stringify(project.sandboxConfig!.mcpServers).includes(MCP_SECRET));
});

test("includeSecrets without a long enough passphrase is a 400", async () => {
  assert.equal((await postExport({ includeSecrets: true })).status, 400);
  assert.equal(
    (await postExport({ includeSecrets: true, passphrase: "short" })).status,
    400,
  );
});

test("even with secrets, layer 3 stays out", async () => {
  const res = await postExport({ includeSecrets: true, passphrase: PASS });
  const doc = (await open(await res.json(), PASS)) as ExportDocument;
  const serialised = JSON.stringify(doc);
  assert.ok(!serialised.includes("civo-instance-SHOULD-NOT-LEAK"));
  assert.ok(!serialised.includes("203.0.113.9"));
});

test("schedules carry their cron and enabled flag for import to disable", async () => {
  const doc = await docOf(await getExport());
  const project = doc.projects.find((p) => p.id === projectId)!;
  assert.equal(project.schedules.length, 1);
  assert.equal(project.schedules[0].cron, "0 3 * * *");
  // Exported as-is; forcing it false is import's job, so the source file stays
  // an accurate record of what the source was doing.
  assert.equal(project.schedules[0].enabled, true);
});

test("the response is a no-store attachment", async () => {
  const res = await getExport();
  assert.match(
    res.headers.get("content-disposition") ?? "",
    /attachment; filename="nexux-export-\d{8}-\d{4}\.json"/,
  );
  assert.equal(res.headers.get("cache-control"), "no-store");

  const enc = await postExport({ includeSecrets: true, passphrase: PASS });
  assert.match(enc.headers.get("content-disposition") ?? "", /\.json\.enc"/);
});

test("schemaVersion reports the last applied migration", async () => {
  const doc = await docOf(await getExport());
  assert.match(doc.meta.schemaVersion, /^\d{14}_/);
});

test("exporting a project with no host paths yields an empty pathRoot", async () => {
  const bare = await prisma.project.create({
    data: { name: "Bare", workspaceId: "ws-export-test" },
  });
  const doc = await docOf(await getExport(`?scope=project&projectId=${bare.id}`));
  assert.equal(doc.meta.pathRoot, "");
  assert.equal(doc.projects[0].workspacePath, null);
  await prisma.project.delete({ where: { id: bare.id } });
});

test("POST rejects a malformed body", async () => {
  const res = await exportPost(
    new NextRequest("http://test/api/export", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(res.status, 400);
});

test("otherProject is untouched by a scoped export", async () => {
  const doc = await docOf(await getExport(`?scope=project&projectId=${projectId}`));
  assert.ok(!doc.projects.some((p) => p.id === otherProjectId));
});
