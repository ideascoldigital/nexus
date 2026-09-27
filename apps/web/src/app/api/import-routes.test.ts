import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";

import { GET as exportGet, POST as exportPost } from "./export/route";
import { POST as importPost } from "./import/route";
import type { ImportPlan } from "@/lib/export/apply";
import type { ExportDocument } from "@/lib/export/schema";

const PASS = "a passphrase long enough";
const SECRET = "pg://user:hunter2@db/app";

let sourceDoc: ExportDocument;
let projectId: string;
let repositoryId: string;
let credentialId: string;
let gitCredentialId: string;
let skillId: string;
let agentId: string;

/** Build a project whose every exported relation is populated. */
async function seedSource() {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-import-test", name: "Import" },
  });

  const credential = await prisma.cloudCredential.create({
    data: {
      workspaceId: workspace.id,
      name: "civo-main",
      provider: "civo",
      data: { token: "civo-secret" },
    },
  });
  credentialId = credential.id;

  // A git credential the repository is explicitly pinned to. Two accounts on
  // one host is the case the pin exists for, so it must survive a migration —
  // losing it drops the repo back to the first-token guess and a private clone
  // starts failing on the destination.
  const gitCredential = await prisma.cloudCredential.create({
    data: {
      workspaceId: workspace.id,
      name: "github-org",
      provider: "github",
      data: { token: "ghp_org" },
    },
  });
  gitCredentialId = gitCredential.id;

  const agent = await prisma.agent.create({
    data: {
      workspaceId: workspace.id,
      name: "architect",
      systemPrompt: "design things",
    },
  });
  agentId = agent.id;

  const skill = await prisma.skill.create({
    data: { workspaceId: workspace.id, name: "search_project", body: "..." },
  });
  skillId = skill.id;

  const project = await prisma.project.create({
    data: {
      name: "Metaphor",
      workspaceId: workspace.id,
      workspacePath: "/Users/dev/workspace/metaphor",
      description: "the one",
    },
  });
  projectId = project.id;

  const repo = await prisma.repository.create({
    data: {
      projectId,
      name: "web",
      isMain: true,
      repoUrl: "git@github.com:acme/web.git",
      localPath: "/Users/dev/workspace/metaphor/web",
      cloneStatus: "ready",
      gitCredentialId,
      setup: { create: { installCommand: "pnpm install", runCommand: "pnpm dev" } },
    },
  });
  repositoryId = repo.id;

  await prisma.projectEnvVar.create({
    data: { projectId, key: "DATABASE_URL", value: SECRET },
  });
  await prisma.stackNode.create({
    data: {
      projectId,
      kind: "repo",
      repositoryId,
      name: "web",
      runMode: "local",
      localCommand: "pnpm dev",
      env: [{ key: "API_KEY", value: "node-secret" }],
      posX: 10,
      posY: 20,
    },
  });
  await prisma.sandboxConfig.create({
    data: {
      projectId,
      provider: "civo",
      credentialId,
      region: "NYC1",
      brain: "opencode",
      mcpServers: { ctx7: { type: "http", url: "https://x" } },
      llmCredentials: { create: [{ credentialId }] },
    },
  });
  const devPhase = await prisma.devPhase.create({
    data: { projectId, name: "MVP", order: 0 },
  });
  await prisma.feature.create({
    data: { projectId, devPhaseId: devPhase.id, title: "Login", order: 0 },
  });
  await prisma.phase.create({
    data: { projectId, key: "discovery", order: 0, title: "Discovery" },
  });
  const doc = await prisma.projectDocument.create({ data: { projectId } });
  await prisma.projectDocumentSection.create({
    data: {
      documentId: doc.id,
      phaseKey: "discovery",
      key: "tech-stack",
      title: "Tech stack",
      content: "next + sqlite",
      ownerRole: "technical-architect",
    },
  });
  await prisma.projectBrain.create({
    data: { projectId, provider: "claude", model: "opus" },
  });
  await prisma.taskSchedule.create({
    data: { projectId, prompt: "nightly", cron: "0 3 * * *", enabled: true },
  });
  await prisma.projectSkill.create({ data: { projectId, skillId } });
  await prisma.projectAgent.create({ data: { projectId, agentId } });
  await prisma.agentSkill.create({ data: { projectId, agentId, skillId } });
}

/** Every row an import should be able to rebuild — dropped between tests. */
async function wipeImportable() {
  await prisma.agentSkill.deleteMany({});
  await prisma.projectAgent.deleteMany({});
  await prisma.projectSkill.deleteMany({});
  await prisma.taskSchedule.deleteMany({});
  await prisma.projectBrain.deleteMany({});
  await prisma.projectDocumentSection.deleteMany({});
  await prisma.projectDocument.deleteMany({});
  await prisma.phase.deleteMany({});
  await prisma.feature.deleteMany({});
  await prisma.devPhase.deleteMany({});
  await prisma.sandboxConfigLlmCredential.deleteMany({});
  await prisma.sandboxConfig.deleteMany({});
  await prisma.stackEdge.deleteMany({});
  await prisma.stackNode.deleteMany({});
  await prisma.projectEnvVar.deleteMany({});
  await prisma.repositorySetup.deleteMany({});
  await prisma.repository.deleteMany({});
  await prisma.project.deleteMany({});
  await prisma.agent.deleteMany({});
  await prisma.skill.deleteMany({});
  await prisma.tool.deleteMany({});
  await prisma.cloudCredential.deleteMany({});
  await prisma.settings.deleteMany({});
  await prisma.workspace.deleteMany({});
}

/** The same source, sealed with secrets. Taken once, before any wipe. */
let sealedDoc: unknown;

function sealSource() {
  return exportPost(
    new NextRequest("http://test/api/export", {
      method: "POST",
      body: JSON.stringify({ includeSecrets: true, passphrase: PASS }),
      headers: { "content-type": "application/json" },
    }),
  );
}

before(async () => {
  await seedSource();
  const res = await exportGet(new NextRequest("http://test/api/export"));
  sourceDoc = (await res.json()) as ExportDocument;
  // Both snapshots must be taken while the seeded rows still exist —
  // `beforeEach` wipes them, so an export inside a test would seal an empty DB.
  sealedDoc = await (await sealSource()).json();
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await wipeImportable();
});

function runImport(body: unknown) {
  return importPost(
    new NextRequest("http://test/api/import", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

const planOf = async (res: Response) => (await res.json()) as ImportPlan;

const DEST_ROOT = "/opt/workspace";

const importDoc = (over: Record<string, unknown> = {}) =>
  runImport({
    dryRun: false,
    pathRoot: DEST_ROOT,
    data: sourceDoc,
    ...over,
  });

test("a dry run writes nothing but reports real counts", async () => {
  const res = await runImport({ dryRun: true, pathRoot: DEST_ROOT, data: sourceDoc });
  assert.equal(res.status, 200);
  const plan = await planOf(res);

  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.projects.length, 1);
  assert.equal(plan.projects[0].action, "create");
  assert.equal(plan.projects[0].counts.repositories.create, 1);
  assert.equal(plan.projects[0].counts.features.create, 1);
  assert.equal(plan.projects[0].counts.stackNodes.create, 1);
  // Visible in the plan, or "did my sandbox config make it?" has no answer.
  assert.equal(plan.projects[0].counts.sandboxConfig.create, 1);

  // Nothing landed.
  assert.equal(await prisma.project.count(), 0);
  assert.equal(await prisma.repository.count(), 0);
});

test("import rebuilds the project from the document", async () => {
  const res = await importDoc();
  assert.equal(res.status, 200);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      repositories: { include: { setup: true } },
      stackNodes: true,
      envVars: true,
      sandboxConfig: { include: { llmCredentials: true } },
      features: true,
      devPhases: true,
      phases: true,
      document: { include: { sections: true } },
      brain: true,
      taskSchedules: true,
      projectSkills: true,
      projectAgents: true,
      agentSkills: true,
    },
  });

  assert.ok(project);
  assert.equal(project.name, "Metaphor");
  assert.equal(project.repositories.length, 1);
  assert.equal(project.repositories[0].setup?.installCommand, "pnpm install");
  assert.equal(project.stackNodes.length, 1);
  assert.equal(project.stackNodes[0].localCommand, "pnpm dev");
  assert.equal(project.envVars.length, 1);
  assert.equal(project.sandboxConfig?.brain, "opencode");
  assert.equal(project.sandboxConfig?.credentialId, credentialId);
  assert.equal(project.sandboxConfig?.llmCredentials.length, 1);
  assert.equal(project.features.length, 1);
  assert.equal(project.features[0].devPhaseId, project.devPhases[0].id);
  assert.equal(project.phases.length, 1);
  assert.equal(project.document?.sections[0].content, "next + sqlite");
  assert.equal(project.brain?.model, "opus");
  assert.equal(project.taskSchedules.length, 1);
  assert.equal(project.projectSkills.length, 1);
  assert.equal(project.projectAgents.length, 1);
  assert.equal(project.agentSkills.length, 1);
});

test("export → import → export round trips to the same document", async () => {
  // The property that makes the format trustworthy.
  await importDoc();
  const again = (await (
    await exportGet(new NextRequest(`http://test/api/export?pathRoot=${DEST_ROOT}`))
  ).json()) as ExportDocument;

  const strip = (d: ExportDocument) => {
    // Both are expected to differ: a fresh timestamp, and a pathRoot that is
    // this machine's rather than the source's.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { exportedAt, pathRoot, ...meta } = d.meta;
    return JSON.stringify({
      ...d,
      meta,
      // `enabled` is the one field import deliberately rewrites: a schedule
      // always lands disabled, so a source that had it on cannot round trip.
      // Everything else must survive byte-for-byte.
      projects: d.projects.map((p) => ({
        ...p,
        schedules: p.schedules.map((s) => ({ ...s, enabled: false })),
      })),
    });
  };
  assert.equal(strip(again), strip(sourceDoc));
});

test("importing twice is idempotent — no duplicate rows", async () => {
  await importDoc();
  const first = {
    projects: await prisma.project.count(),
    repos: await prisma.repository.count(),
    features: await prisma.feature.count(),
    envVars: await prisma.projectEnvVar.count(),
    joins: await prisma.projectSkill.count(),
    llmJoins: await prisma.sandboxConfigLlmCredential.count(),
  };

  await importDoc();
  assert.deepEqual(
    {
      projects: await prisma.project.count(),
      repos: await prisma.repository.count(),
      features: await prisma.feature.count(),
      envVars: await prisma.projectEnvVar.count(),
      joins: await prisma.projectSkill.count(),
      llmJoins: await prisma.sandboxConfigLlmCredential.count(),
    },
    first,
  );
});

test("host paths are rebased onto the destination root", async () => {
  await importDoc();
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { repositories: true },
  });
  assert.equal(project?.workspacePath, "/opt/workspace/metaphor");
  assert.equal(project?.repositories[0].localPath, "/opt/workspace/metaphor/web");
});

// Previously a refusal. A rootless import now lands under this install's own
// workspace instead: the paths in the file describe the *source* machine, and
// on a Nexus host the app can only write to the workspace volume it declared —
// so "no root given" has exactly one safe answer, and refusing left the user
// to guess a path (typically /opt/workspace) that no clone could ever use.
test("a relative-path file without a destination root uses this install's workspace", async () => {
  const res = await runImport({ dryRun: true, data: sourceDoc });
  assert.equal(res.status, 200);
  const plan = await planOf(res);
  assert.equal(plan.ok, true);

  const root = getConfig().workspaceRoot;
  const workspacePath = plan.projects[0].paths.find(
    (p) => p.field === "workspacePath",
  );
  assert.equal(workspacePath?.resolved, `${root}/metaphor`);
});

test("the dry run reports whether each resolved path exists on disk", async () => {
  const plan = await planOf(
    await runImport({ dryRun: true, pathRoot: testDbDir, data: sourceDoc }),
  );
  const paths = plan.projects[0].paths;
  assert.ok(paths.some((p) => p.field === "workspacePath"));
  // Nothing was cloned here, so a config import legitimately precedes the
  // directories existing — reported as information, not an error.
  assert.ok(paths.every((p) => p.existsOnDisk === false));
  assert.equal(plan.errors.length, 0);
});

test("repositories never arrive marked as cloned", async () => {
  await importDoc();
  const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
  // The source had cloneStatus "ready"; the checkout is this host's business.
  assert.equal(repo?.cloneStatus, "pending");
});

// Unlike localPath, the pinned credential is not host-specific — credentials
// travel in the same file — so it must arrive intact. Dropping it silently
// returns the repo to "whichever token for this host was saved first", which
// is exactly the guess that cannot see another account's private repo.
test("a repository keeps the git credential it was pinned to", async () => {
  await importDoc();
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
  });
  assert.equal(repo?.gitCredentialId, gitCredentialId);
});

test("a pinned credential the destination lacks falls back instead of failing", async () => {
  // The realistic shape of this: a file exported from an install that had a
  // credential this one never did. A dangling foreign key would abort the whole
  // import, so it degrades to the provider-wide fallback instead.
  const doc = structuredClone(sourceDoc) as typeof sourceDoc;
  doc.projects[0].repositories[0].gitCredentialId = "cred-that-never-existed";

  const res = await runImport({ dryRun: false, pathRoot: DEST_ROOT, data: doc });
  assert.equal(res.status, 200);

  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
  });
  assert.equal(repo?.gitCredentialId, null);
});

test("schedules always arrive disabled with their run bookkeeping cleared", async () => {
  await prisma.taskSchedule.deleteMany({});
  const plan = await planOf(await importDoc());
  assert.equal(plan.schedules.importedDisabled, 1);

  const schedule = await prisma.taskSchedule.findFirst({ where: { projectId } });
  assert.equal(schedule?.enabled, false);
  assert.equal(schedule?.cron, "0 3 * * *");
  assert.equal(schedule?.nextRunAt, null);
  assert.equal(schedule?.lastTaskId, null);
});

test("a secretless import leaves env var keys with empty values and counts them", async () => {
  const plan = await planOf(await importDoc());
  assert.equal(plan.envVars.needsValue, 1);

  const envVar = await prisma.projectEnvVar.findFirst({ where: { projectId } });
  assert.equal(envVar?.key, "DATABASE_URL");
  assert.equal(envVar?.value, "");
});

test("a secretless import never blanks a secret already on the destination", async () => {
  await importDoc();
  await prisma.projectEnvVar.updateMany({
    where: { projectId },
    data: { value: "locally-set-value" },
  });
  await prisma.cloudCredential.update({
    where: { id: credentialId },
    data: { data: { token: "locally-set-token" } },
  });

  const plan = await planOf(await importDoc());

  const envVar = await prisma.projectEnvVar.findFirst({ where: { projectId } });
  assert.equal(envVar?.value, "locally-set-value");
  const cred = await prisma.cloudCredential.findUnique({ where: { id: credentialId } });
  assert.deepEqual(cred?.data, { token: "locally-set-token" });
  // Already filled in here, so it is not on the checklist.
  assert.equal(plan.envVars.needsValue, 0);
  assert.ok(!plan.credentials.needsSecret.includes("civo-main"));
});

test("credential shells import with their identity and are flagged needsSecret", async () => {
  const plan = await planOf(await importDoc());
  // Both saved credentials are shells without their secrets — the git one is
  // flagged for the same reason as the cloud one.
  assert.deepEqual([...plan.credentials.needsSecret].sort(), [
    "civo-main",
    "github-org",
  ]);

  const cred = await prisma.cloudCredential.findUnique({ where: { id: credentialId } });
  assert.equal(cred?.name, "civo-main");
  assert.equal(cred?.provider, "civo");
  // The FK survives, so the project still pins this credential (D-28).
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.credentialId, credentialId);
});

test("a sealed file imports its secrets once opened", async () => {
  const plan = await planOf(
    await runImport({
      dryRun: false,
      pathRoot: DEST_ROOT,
      passphrase: PASS,
      data: sealedDoc,
    }),
  );

  assert.equal(plan.ok, true);
  assert.equal(plan.envVars.needsValue, 0);
  const envVar = await prisma.projectEnvVar.findFirst({ where: { projectId } });
  assert.equal(envVar?.value, SECRET);
  const cred = await prisma.cloudCredential.findUnique({ where: { id: credentialId } });
  assert.deepEqual(cred?.data, { token: "civo-secret" });
});

test("a sealed file without the passphrase is refused", async () => {
  const noPass = await runImport({
    dryRun: true,
    pathRoot: DEST_ROOT,
    data: sealedDoc,
  });
  assert.equal(noPass.status, 400);

  const wrongPass = await runImport({
    dryRun: true,
    pathRoot: DEST_ROOT,
    passphrase: "wrong passphrase!",
    data: sealedDoc,
  });
  assert.equal(wrongPass.status, 400);
});

test("replace deletes rows the file does not carry; merge leaves them", async () => {
  await importDoc();
  const stray = await prisma.feature.create({
    data: { projectId, title: "Added here later", order: 99 },
  });

  // merge is additive.
  await importDoc({ mode: "merge" });
  assert.ok(await prisma.feature.findUnique({ where: { id: stray.id } }));

  // replace makes the destination match the file.
  const plan = await planOf(await importDoc({ mode: "replace" }));
  assert.equal(plan.projects[0].counts.features.delete, 1);
  assert.equal(await prisma.feature.findUnique({ where: { id: stray.id } }), null);
  // What the file does carry survives.
  assert.equal(await prisma.feature.count({ where: { projectId } }), 1);
});

test("replace reports its deletions in a dry run without performing them", async () => {
  await importDoc();
  const stray = await prisma.projectEnvVar.create({
    data: { projectId, key: "EXTRA", value: "x" },
  });

  const plan = await planOf(
    await runImport({
      dryRun: true,
      mode: "replace",
      pathRoot: DEST_ROOT,
      data: sourceDoc,
    }),
  );
  assert.equal(plan.projects[0].counts.envVars.delete, 1);
  assert.ok(await prisma.projectEnvVar.findUnique({ where: { id: stray.id } }));
});

test("replace never touches layer 3", async () => {
  await importDoc();
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "box",
      region: "NYC1",
      size: "g3.medium",
      workDir: "/tmp/tf",
    },
  });
  await importDoc({ mode: "replace" });
  // Sandboxes are machine state: the file never carried them, and replace must
  // not read their absence as "delete".
  assert.ok(await prisma.sandbox.findUnique({ where: { id: sandbox.id } }));
  await prisma.sandbox.delete({ where: { id: sandbox.id } });
});

test("a catalog name collision keeps the incumbent and rewires the joins", async () => {
  // Agent.name and Skill.name are globally @unique, so the same name under a
  // different id is a real conflict — upserting by id would throw.
  await prisma.workspace.create({ data: { id: "ws-import-test", name: "Import" } });
  const localAgent = await prisma.agent.create({
    data: {
      workspaceId: "ws-import-test",
      name: "architect",
      systemPrompt: "local version",
    },
  });
  const localSkill = await prisma.skill.create({
    data: { workspaceId: "ws-import-test", name: "search_project" },
  });

  const plan = await planOf(await importDoc());
  assert.match(plan.warnings.join(" "), /already exists here under a different id/);

  // No duplicate rows, and the incumbent kept its id.
  assert.equal(await prisma.agent.count({ where: { name: "architect" } }), 1);
  assert.equal(await prisma.skill.count({ where: { name: "search_project" } }), 1);

  // The project's joins point at the incumbent, not the file's dead id.
  const join = await prisma.projectAgent.findFirst({ where: { projectId } });
  assert.equal(join?.agentId, localAgent.id);
  const skillJoin = await prisma.projectSkill.findFirst({ where: { projectId } });
  assert.equal(skillJoin?.skillId, localSkill.id);
});

test("a file from a newer schema is refused and nothing is written", async () => {
  const future = {
    ...sourceDoc,
    meta: { ...sourceDoc.meta, schemaVersion: "99999999999999_future" },
  };
  const res = await runImport({ dryRun: false, pathRoot: DEST_ROOT, data: future });
  assert.equal(res.status, 422);
  const plan = await planOf(res);
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(" "), /newer schema/);
  assert.equal(await prisma.project.count(), 0);
});

test("a file from an older schema imports with a warning", async () => {
  const past = {
    ...sourceDoc,
    meta: { ...sourceDoc.meta, schemaVersion: "20200101000000_ancient" },
  };
  const plan = await planOf(
    await runImport({ dryRun: false, pathRoot: DEST_ROOT, data: past }),
  );
  assert.equal(plan.ok, true);
  assert.match(plan.warnings.join(" "), /predates this install's schema/);
  assert.equal(await prisma.project.count(), 1);
});

test("a newer export envelope version is refused", async () => {
  const future = {
    ...sourceDoc,
    meta: { ...sourceDoc.meta, nexuxExportVersion: 99 },
  };
  const res = await runImport({ dryRun: true, pathRoot: DEST_ROOT, data: future });
  assert.equal(res.status, 422);
  assert.match((await planOf(res)).errors.join(" "), /newer than this install/);
});

test("a document that is not a Nexus export is rejected", async () => {
  const res = await runImport({ dryRun: true, data: { hello: "world" } });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Not a valid Nexus export/);
});

test("importing a telegram setting that already exists warns rather than picking a winner", async () => {
  await prisma.settings.create({
    data: { key: "telegram_bot_token", value: "destination-token" },
  });
  const withSetting = {
    ...sourceDoc,
    settings: [
      {
        id: "s1",
        key: "telegram_bot_token",
        value: "source-token",
        provider: null,
        isActive: true,
      },
    ],
  };
  const plan = await planOf(
    await runImport({ dryRun: true, pathRoot: DEST_ROOT, data: withSetting }),
  );
  // The bot long-polls as a singleton; two installs sharing a token fight.
  assert.match(plan.warnings.join(" "), /fight over updates/);
});

test("a malformed body is a 400", async () => {
  const res = await importPost(
    new NextRequest("http://test/api/import", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(res.status, 400);
});

// --- seed data (spec 29) -------------------------------------------------------
// The file never travels in an export; what the seed was does, so the
// destination can say what is missing.

test("an export carries what a seed was, never the file", async () => {
  const workspace = await prisma.workspace.upsert({
    where: { id: "ws-import-test" },
    create: { id: "ws-import-test", name: "Import" },
    update: {},
  });
  const project = await prisma.project.create({ data: { name: "Seeded", workspaceId: workspace.id } });
  const node = await prisma.stackNode.create({
    data: { projectId: project.id, kind: "service", name: "db", image: "postgres:17" },
  });
  await prisma.seedData.create({
    data: {
      projectId: project.id,
      stackNodeId: node.id,
      fileName: "prod.dump",
      format: "pg-custom",
      sizeBytes: BigInt(5 * 1024 * 1024),
      sha256: "d".repeat(64),
    },
  });
  const doc = (await (await exportGet(new NextRequest("http://test/api/export"))).json()) as ExportDocument;
  const exported = doc.projects.find((p) => p.id === project.id)!.stack.nodes[0];
  assert.deepEqual(exported.seed, {
    fileName: "prod.dump",
    format: "pg-custom",
    sizeBytes: 5 * 1024 * 1024,
    sha256: "d".repeat(64),
    sensitive: true,
  });
  const template = (await (await exportGet(new NextRequest("http://test/api/export?template=true"))).json()) as ExportDocument;
  assert.equal(template.projects.find((p) => p.id === project.id)!.stack.nodes[0].seed, null, "a template carries no one's data");
});

test("importing a project whose service had a seed says to attach it again", async () => {
  const doc = structuredClone(sourceDoc);
  doc.projects[0].stack.nodes[0].seed = {
    fileName: "prod.dump",
    format: "pg-custom",
    sizeBytes: 3 * 1024 * 1024,
    sha256: "e".repeat(64),
    sensitive: true,
  };
  const plan = await planOf(await runImport({ dryRun: true, pathRoot: DEST_ROOT, data: doc }));
  assert.ok(
    plan.warnings.some((w) => /Seed data for ".+" .*\(prod\.dump, 3\.0 MB\) is not part of an export/.test(w)),
    JSON.stringify(plan.warnings),
  );
  assert.equal(plan.ok, true, "a missing seed is a warning, not a refusal");
});
