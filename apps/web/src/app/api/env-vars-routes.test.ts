import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import {
  GET as listPresets,
  POST as importFromConfig,
} from "./projects/[projectId]/env-vars/from-config/route";
import { PUT as updateEnvVar } from "./projects/[projectId]/env-vars/[envVarId]/route";

let projectId: string;
let repositoryId: string;
let foreignRepositoryId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-presets-test", name: "Presets" },
  });
  const [project, other] = await Promise.all([
    prisma.project.create({ data: { name: "Main", workspaceId: workspace.id } }),
    prisma.project.create({
      data: { name: "Other", workspaceId: workspace.id },
    }),
  ]);
  projectId = project.id;
  const [repo, foreign] = await Promise.all([
    prisma.repository.create({ data: { projectId, name: "web", isMain: true } }),
    prisma.repository.create({
      data: { projectId: other.id, name: "theirs" },
    }),
  ]);
  repositoryId = repo.id;
  foreignRepositoryId = foreign.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.projectEnvVar.deleteMany({});
  await prisma.settings.deleteMany({});
  await prisma.cloudCredential.deleteMany({});
});

const get = (id = projectId) =>
  listPresets(new NextRequest("http://test/api/from-config"), {
    params: Promise.resolve({ projectId: id }),
  });

const post = (body: unknown, id = projectId) =>
  importFromConfig(
    new NextRequest("http://test/api/from-config", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id }) },
  );

type Preset = {
  id: string;
  group: string;
  key: string;
  label: string;
  valueMasked: string;
};

const presetsOf = async (res: Response) =>
  ((await res.json()) as { presets: Preset[] }).presets;

type ImportResult = {
  created: string[];
  updated: string[];
  skipped: string[];
  missing: string[];
  error?: string;
};

const resultOf = async (res: Response) => (await res.json()) as ImportResult;

test("lists credentials and settings as presets, values masked", async () => {
  await prisma.cloudCredential.createMany({
    data: [
      {
        name: "claude-smart",
        provider: "claude",
        data: { token: "sk-ant-oat-SECRETVALUE" },
      },
      { name: "personal", provider: "github", data: { token: "ghp_TOKENVAL" } },
      { name: "work", provider: "openai", data: { apiKey: "sk-openaiKEYY" } },
      // Not an env-var source — provisioning only, must never be offered.
      { name: "civo-main", provider: "civo", data: { token: "civo-secret" } },
    ],
  });
  await prisma.settings.create({
    data: { key: "openrouter_api_key", value: "or-v1-ROUTERKEY" },
  });

  const presets = await presetsOf(await get());
  const byKey = new Map(presets.map((p) => [p.key, p]));

  assert.deepEqual(
    [...byKey.keys()].sort(),
    ["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  );
  assert.equal(byKey.get("CLAUDE_CODE_OAUTH_TOKEN")?.group, "claude");
  assert.equal(byKey.get("GITHUB_TOKEN")?.group, "git");
  assert.equal(byKey.get("OPENAI_API_KEY")?.group, "llm");
  assert.equal(byKey.get("OPENROUTER_API_KEY")?.group, "settings");
  assert.equal(byKey.get("CLAUDE_CODE_OAUTH_TOKEN")?.label, "claude-smart");

  // No plaintext may cross the wire on the listing path.
  const serialised = JSON.stringify(presets);
  for (const secret of [
    "sk-ant-oat-SECRETVALUE",
    "ghp_TOKENVAL",
    "sk-openaiKEYY",
    "or-v1-ROUTERKEY",
    "civo-secret",
  ]) {
    assert.equal(serialised.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(byKey.get("OPENAI_API_KEY")?.valueMasked, "••••KEYY");
});

test("skips credentials whose secret is blank or in the wrong field", async () => {
  await prisma.cloudCredential.createMany({
    data: [
      // LLM keys live in data.apiKey — a token here is not a usable value.
      { name: "misfiled", provider: "openai", data: { token: "sk-wrongfield" } },
      { name: "empty", provider: "github", data: { token: "   " } },
    ],
  });
  await prisma.settings.create({
    data: { key: "xai_api_key", value: "  " },
  });

  assert.deepEqual(await presetsOf(await get()), []);
});

test("imports selected presets by id, resolving values server-side", async () => {
  const cred = await prisma.cloudCredential.create({
    data: {
      name: "claude-smart",
      provider: "claude",
      data: { token: "sk-ant-oat-XYZ" },
    },
  });
  await prisma.settings.create({
    data: { key: "openai_api_key", value: "sk-openai-123" },
  });

  const res = await resultOf(
    await post({
      presetIds: [`credential:${cred.id}`, "setting:openai_api_key"],
    }),
  );
  assert.deepEqual(res.created.sort(), [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
  ]);
  assert.deepEqual(res.updated, []);

  const rows = await prisma.projectEnvVar.findMany({ where: { projectId } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  assert.equal(stored.get("CLAUDE_CODE_OAUTH_TOKEN"), "sk-ant-oat-XYZ");
  assert.equal(stored.get("OPENAI_API_KEY"), "sk-openai-123");
  // Project-wide by default.
  assert.equal(rows.every((r) => r.repositoryId === null), true);
});

test("overwrite=false leaves an existing key untouched", async () => {
  await prisma.settings.create({
    data: { key: "openai_api_key", value: "sk-from-settings" },
  });
  await prisma.projectEnvVar.create({
    data: { projectId, repositoryId: null, key: "OPENAI_API_KEY", value: "mine" },
  });

  const skip = await resultOf(
    await post({ presetIds: ["setting:openai_api_key"], overwrite: false }),
  );
  assert.deepEqual(skip.skipped, ["OPENAI_API_KEY"]);
  assert.equal(
    (await prisma.projectEnvVar.findFirst({ where: { projectId } }))?.value,
    "mine",
  );

  const over = await resultOf(
    await post({ presetIds: ["setting:openai_api_key"], overwrite: true }),
  );
  assert.deepEqual(over.updated, ["OPENAI_API_KEY"]);
  assert.equal(
    (await prisma.projectEnvVar.findFirst({ where: { projectId } }))?.value,
    "sk-from-settings",
  );
});

test("repo scope is separate from project-wide and must belong to the project", async () => {
  await prisma.settings.create({
    data: { key: "google_api_key", value: "gem-key" },
  });
  await prisma.projectEnvVar.create({
    data: { projectId, repositoryId: null, key: "GEMINI_API_KEY", value: "wide" },
  });

  const res = await resultOf(
    await post({ presetIds: ["setting:google_api_key"], repositoryId }),
  );
  // The project-wide row of the same name must not count as existing here.
  assert.deepEqual(res.created, ["GEMINI_API_KEY"]);
  assert.equal(await prisma.projectEnvVar.count({ where: { projectId } }), 2);

  const foreign = await post({
    presetIds: ["setting:google_api_key"],
    repositoryId: foreignRepositoryId,
  });
  assert.equal(foreign.status, 400);
});

test("stale and unknown preset ids are reported, not fatal", async () => {
  await prisma.settings.create({
    data: { key: "openai_api_key", value: "sk-live" },
  });

  const res = await resultOf(
    await post({
      presetIds: [
        "credential:deleted-id",
        "setting:civo_api_key", // real Settings key, deliberately not allowlisted
        "garbage",
        "setting:openai_api_key",
      ],
    }),
  );
  assert.deepEqual(res.created, ["OPENAI_API_KEY"]);
  assert.deepEqual(res.missing.sort(), [
    "credential:deleted-id",
    "garbage",
    "setting:civo_api_key",
  ]);
});

test("an import with nothing resolvable is a 400, and writes nothing", async () => {
  const res = await post({ presetIds: ["credential:gone"] });
  assert.equal(res.status, 400);
  assert.equal(await prisma.projectEnvVar.count({ where: { projectId } }), 0);
});

test("unknown project 404s on the listing path", async () => {
  assert.equal((await get("nope")).status, 404);
});

const put = (envVarId: string, body: unknown, id = projectId) =>
  updateEnvVar(
    new NextRequest("http://test/api/env-var", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id, envVarId }) },
  );

const makeVar = (key: string, value = "secret", repoId: string | null = null) =>
  prisma.projectEnvVar.create({
    data: { projectId, repositoryId: repoId, key, value },
  });

test("renaming a key keeps the stored value when none is sent", async () => {
  const row = await makeVar("OLD_NAME", "keep-me");

  assert.equal((await put(row.id, { key: "NEW_NAME" })).status, 200);

  const after = await prisma.projectEnvVar.findUnique({
    where: { id: row.id },
  });
  assert.equal(after?.key, "NEW_NAME");
  assert.equal(after?.value, "keep-me");
});

test("key and value can change together", async () => {
  const row = await makeVar("OLD_NAME", "old-value");

  await put(row.id, { key: "NEW_NAME", value: "new-value" });

  const after = await prisma.projectEnvVar.findUnique({
    where: { id: row.id },
  });
  assert.equal(after?.key, "NEW_NAME");
  assert.equal(after?.value, "new-value");
});

test("a value-only update still works and leaves the key alone", async () => {
  const row = await makeVar("SAME_NAME", "old-value");

  await put(row.id, { value: "new-value" });

  const after = await prisma.projectEnvVar.findUnique({
    where: { id: row.id },
  });
  assert.equal(after?.key, "SAME_NAME");
  assert.equal(after?.value, "new-value");
});

test("renaming onto an existing key at the same scope is a 409", async () => {
  const row = await makeVar("FROM_KEY", "mine");
  await makeVar("TAKEN_KEY", "theirs");

  const res = await put(row.id, { key: "TAKEN_KEY" });
  assert.equal(res.status, 409);

  // Neither row may move.
  const after = await prisma.projectEnvVar.findUnique({
    where: { id: row.id },
  });
  assert.equal(after?.key, "FROM_KEY");
  assert.equal(after?.value, "mine");
});

test("the same key under a different scope is not a collision", async () => {
  const row = await makeVar("FROM_KEY", "mine");
  await makeVar("TAKEN_KEY", "repo-scoped", repositoryId);

  assert.equal((await put(row.id, { key: "TAKEN_KEY" })).status, 200);
  assert.equal(
    (await prisma.projectEnvVar.findUnique({ where: { id: row.id } }))?.key,
    "TAKEN_KEY",
  );
});

test("renaming a key to itself is accepted, not a self-collision", async () => {
  const row = await makeVar("SAME_NAME", "v");

  assert.equal(
    (await put(row.id, { key: "SAME_NAME", value: "v2" })).status,
    200,
  );
});

test("an invalid key name is rejected and nothing is written", async () => {
  const row = await makeVar("GOOD_NAME", "v");

  for (const key of ["1BAD", "has-dash", "has.dot", "has space", ""]) {
    assert.equal((await put(row.id, { key })).status, 400, `accepted ${key}`);
  }
  assert.equal(
    (await prisma.projectEnvVar.findUnique({ where: { id: row.id } }))?.key,
    "GOOD_NAME",
  );
});

test("an empty update is rejected", async () => {
  const row = await makeVar("SOME_NAME", "v");
  assert.equal((await put(row.id, {})).status, 400);
});

test("an env var from another project cannot be renamed", async () => {
  const row = await makeVar("MINE", "v");
  assert.equal((await put(row.id, { key: "RENAMED" }, "other-project")).status, 404);
  assert.equal(
    (await prisma.projectEnvVar.findUnique({ where: { id: row.id } }))?.key,
    "MINE",
  );
});
