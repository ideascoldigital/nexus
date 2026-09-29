import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import {
  GET as getSetup,
  PUT as saveSetup,
} from "./projects/[projectId]/setup/route";

let projectId: string;
let repositoryId: string;
let foreignRepositoryId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-setup-test", name: "Setup" },
  });
  const [project, other] = await Promise.all([
    prisma.project.create({ data: { name: "Main", workspaceId: workspace.id } }),
    prisma.project.create({ data: { name: "Other", workspaceId: workspace.id } }),
  ]);
  projectId = project.id;
  const [repo, foreign] = await Promise.all([
    prisma.repository.create({ data: { projectId, name: "web", isMain: true } }),
    prisma.repository.create({ data: { projectId: other.id, name: "theirs" } }),
  ]);
  repositoryId = repo.id;
  foreignRepositoryId = foreign.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.sandboxConfigLlmCredential.deleteMany({});
  await prisma.sandboxConfig.deleteMany({});
  await prisma.repositorySetup.deleteMany({});
  await prisma.projectEnvVar.deleteMany({});
  await prisma.settings.deleteMany({});
  await prisma.cloudCredential.deleteMany({});
});

/** A complete, valid sandbox config — every required field present. */
const validConfig = (over: Record<string, unknown> = {}) => ({
  provider: "civo",
  region: "lon1",
  size: "g3.small",
  diskImage: "ubuntu-24",
  installDocker: true,
  installNode: true,
  installClaudeCode: true,
  installAgentBrowser: false,
  installCloudflared: false,
  includeStackServices: true,
  createPr: true,
  runTests: true,
  captureScreenshots: false,
  livePreview: false,
  previewPort: null,
  brain: "claude",
  ...over,
});

const put = (body: unknown, id = projectId) =>
  saveSetup(
    new NextRequest("http://test/api/setup", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id }) }
  );

const get = (id = projectId) =>
  getSetup(new NextRequest("http://test/api/setup"), {
    params: Promise.resolve({ projectId: id }),
  });

type SetupBody = {
  config: Record<string, unknown> | null;
  repositories: { id: string; setup?: unknown }[];
  globalEnvVars: {
    key: string;
    valueMasked: string;
    applied: boolean;
    reason: string | null;
    source: string;
    credentialName?: string | null;
    note?: string | null;
  }[];
  envVars: { key: string; valueMasked: string }[];
};

const body = async (res: Response) => (await res.json()) as SetupBody;

// --- GET --------------------------------------------------------------------

test("an unknown project is a 404", async () => {
  assert.equal((await get("no-such-project")).status, 404);
});

test("a project with no config still gets usable defaults", async () => {
  // The panel needs a config to render, so the route fills one in rather
  // than handing the client a null to special-case.
  const res = await get();
  assert.equal(res.status, 200);
  const setup = await body(res);
  assert.ok(setup.config, "expected a defaulted config");
  assert.equal(setup.config.provider, "civo");
  assert.ok(setup.config.region, "a region is preselected");
  assert.deepEqual(setup.config.llmCredentialIds, []);
  assert.deepEqual(
    setup.repositories.map((r) => r.id),
    [repositoryId]
  );
});

test("project env values are masked, never returned in full", async () => {
  // This panel is read by the browser; the raw secret must not leave the API.
  await prisma.projectEnvVar.create({
    data: { projectId, key: "API_KEY", value: "supersecret-1234" },
  });
  const setup = await body(await get());
  const row = setup.envVars.find((v) => v.key === "API_KEY");
  assert.equal(row?.valueMasked, "••••1234");
  assert.equal(JSON.stringify(setup).includes("supersecret"), false);
});

test("a short secret is masked without leaking any of it", async () => {
  await prisma.projectEnvVar.create({
    data: { projectId, key: "SHORT", value: "abc" },
  });
  const setup = await body(await get());
  assert.equal(setup.envVars.find((v) => v.key === "SHORT")?.valueMasked, "••••");
});

test("an active global secret is listed as applied", async () => {
  await prisma.settings.create({
    data: { key: "openai_api_key", value: "sk-live-9999", isActive: true },
  });
  const setup = await body(await get());
  const row = setup.globalEnvVars.find((v) => v.key === "OPENAI_API_KEY");
  assert.ok(row, "expected the global secret to be listed");
  assert.equal(row.applied, true);
  assert.equal(row.reason, null);
  assert.equal(row.valueMasked, "••••9999");
});

test("an inactive global secret is not offered at all", async () => {
  await prisma.settings.create({
    data: { key: "openai_api_key", value: "sk-live-9999", isActive: false },
  });
  const setup = await body(await get());
  assert.equal(
    setup.globalEnvVars.some((v) => v.key === "OPENAI_API_KEY"),
    false
  );
});

test("a project env var overrides the global one and says so", async () => {
  await prisma.settings.create({
    data: { key: "openai_api_key", value: "sk-global", isActive: true },
  });
  await prisma.projectEnvVar.create({
    data: { projectId, key: "OPENAI_API_KEY", value: "sk-project" },
  });
  const setup = await body(await get());
  const row = setup.globalEnvVars.find((v) => v.key === "OPENAI_API_KEY");
  assert.equal(row?.applied, false);
  assert.match(row?.reason ?? "", /overridden by a project env var/);
});

test("the Anthropic key is withheld when a Claude Code token exists", async () => {
  // The CLI would prefer the API key over the OAuth token, so it is held back.
  await prisma.settings.create({
    data: { key: "anthropic_api_key", value: "sk-ant-1234", isActive: true },
  });
  await prisma.projectEnvVar.create({
    data: { projectId, key: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok-abcd" },
  });
  const setup = await body(await get());
  const row = setup.globalEnvVars.find((v) => v.key === "ANTHROPIC_API_KEY");
  assert.equal(row?.applied, false);
  assert.match(row?.reason ?? "", /Claude Code token takes auth precedence/);
});

test("the Anthropic key applies when no Claude token is present", async () => {
  await prisma.settings.create({
    data: { key: "anthropic_api_key", value: "sk-ant-1234", isActive: true },
  });
  const setup = await body(await get());
  const row = setup.globalEnvVars.find((v) => v.key === "ANTHROPIC_API_KEY");
  assert.equal(row?.applied, true);
});

// --- PUT validation ---------------------------------------------------------

test("an empty body is accepted as a no-op", async () => {
  const res = await put({});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("saving against an unknown project is a 404", async () => {
  assert.equal((await put({}, "no-such-project")).status, 404);
});

test("a config missing required fields is rejected", async () => {
  const { region, ...withoutRegion } = validConfig();
  assert.ok(region);
  assert.equal((await put({ config: withoutRegion })).status, 400);
});

test("an unknown provider or brain is rejected", async () => {
  assert.equal(
    (await put({ config: validConfig({ provider: "gcp" }) })).status,
    400
  );
  assert.equal(
    (await put({ config: validConfig({ brain: "gpt" }) })).status,
    400
  );
});

test("local is a provider a project can be saved with", async () => {
  // launchSandbox branches on `sandboxConfig.provider === "local"` to run the
  // container path; a schema that refuses the value makes that branch
  // reachable only through a per-launch override, and the drawer's choice is
  // silently lost on every save.
  const res = await put({
    config: validConfig({ provider: "local", region: "local", size: "docker" }),
  });
  assert.equal(res.status, 200);
  const setup = await (await get()).json();
  assert.equal(setup.config.provider, "local");
});

test("a preview port outside the valid range is rejected", async () => {
  assert.equal(
    (await put({ config: validConfig({ previewPort: 0 }) })).status,
    400
  );
  assert.equal(
    (await put({ config: validConfig({ previewPort: 70000 }) })).status,
    400
  );
  assert.equal(
    (await put({ config: validConfig({ previewPort: 3000 }) })).status,
    200
  );
});

// --- PUT behaviour ----------------------------------------------------------

test("a valid config is stored and read back", async () => {
  assert.equal((await put({ config: validConfig() })).status, 200);
  const setup = await body(await get());
  assert.equal(setup.config?.region, "lon1");
  assert.equal(setup.config?.size, "g3.small");
});

test("saving twice updates the config rather than duplicating it", async () => {
  await put({ config: validConfig() });
  await put({ config: validConfig({ region: "nyc1" }) });
  const configs = await prisma.sandboxConfig.findMany({ where: { projectId } });
  assert.equal(configs.length, 1);
  assert.equal(configs[0].region, "nyc1");
});

test("blank text fields are stored as null, not as empty strings", async () => {
  await put({
    config: validConfig({ branch: "   ", setupScript: "", agentInstructions: "  " }),
  });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.branch, null);
  assert.equal(config?.setupScript, null);
  assert.equal(config?.agentInstructions, null);
});

test("text fields are trimmed before being stored", async () => {
  await put({ config: validConfig({ branch: "  main  " }) });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.branch, "main");
});

test("the OpenCode brain always installs its CLI", async () => {
  // Selecting the brain without the install flag would produce a sandbox
  // that cannot run it.
  await put({ config: validConfig({ brain: "opencode", installOpenCode: false }) });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.installOpenCode, true);
});

test("the Claude brain leaves the OpenCode install flag alone", async () => {
  await put({ config: validConfig({ brain: "claude", installOpenCode: false }) });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.installOpenCode, false);
});

test("a stale credential reference is dropped instead of blocking the save", async () => {
  const res = await put({
    config: validConfig({ credentialId: "deleted-credential" }),
  });
  assert.equal(res.status, 200);
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.credentialId, null);
  assert.equal(config?.region, "lon1", "the rest of the config still saved");
});

test("a real credential reference is kept", async () => {
  const credential = await prisma.cloudCredential.create({
    data: {
      name: "civo-main",
      provider: "civo",
      workspaceId: "ws-setup-test",
      data: { token: "tok" },
    },
  });
  await put({ config: validConfig({ credentialId: credential.id }) });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.credentialId, credential.id);
});

test("tailscale toggle and credential are stored and read back", async () => {
  const credential = await prisma.cloudCredential.create({
    data: {
      name: "tailnet",
      provider: "tailscale",
      workspaceId: "ws-setup-test",
      data: { token: "tskey-auth-x" },
    },
  });
  await put({
    config: validConfig({
      installTailscale: true,
      tailscaleCredentialId: credential.id,
    }),
  });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.installTailscale, true);
  assert.equal(config?.tailscaleCredentialId, credential.id);
});

test("omitting the tailscale fields keeps the feature off", async () => {
  // Pre-tailscale clients send configs without these keys; that must stay a
  // valid save with the feature disabled, not a validation error.
  await put({ config: validConfig() });
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.installTailscale, false);
  assert.equal(config?.tailscaleCredentialId, null);
});

test("a stale tailscale credential is dropped but the toggle survives", async () => {
  const res = await put({
    config: validConfig({
      installTailscale: true,
      tailscaleCredentialId: "deleted-credential",
    }),
  });
  assert.equal(res.status, 200);
  const config = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  assert.equal(config?.installTailscale, true);
  assert.equal(config?.tailscaleCredentialId, null);
});

test("llm credentials are replaced wholesale, dropping unknown ids", async () => {
  const [a, b] = await Promise.all([
    prisma.cloudCredential.create({
      data: {
        name: "a",
        provider: "openai",
        workspaceId: "ws-setup-test",
        data: { token: "t" },
      },
    }),
    prisma.cloudCredential.create({
      data: {
        name: "b",
        provider: "anthropic",
        workspaceId: "ws-setup-test",
        data: { token: "t" },
      },
    }),
  ]);
  await put({ config: validConfig({ llmCredentialIds: [a.id, "bogus"] }) });
  const saved = await prisma.sandboxConfig.findUnique({
    where: { projectId },
    include: { llmCredentials: true },
  });
  assert.deepEqual(
    saved?.llmCredentials.map((c) => c.credentialId),
    [a.id]
  );

  await put({ config: validConfig({ llmCredentialIds: [b.id] }) });
  const replaced = await prisma.sandboxConfig.findUnique({
    where: { projectId },
    include: { llmCredentials: true },
  });
  assert.deepEqual(
    replaced?.llmCredentials.map((c) => c.credentialId),
    [b.id]
  );
});

test("a repo setup is stored for this project's repository", async () => {
  const res = await put({
    repoSetups: [
      { repositoryId, installCommand: "pnpm i", buildCommand: "pnpm build" },
    ],
  });
  assert.equal(res.status, 200);
  const setup = await prisma.repositorySetup.findUnique({
    where: { repositoryId },
  });
  assert.equal(setup?.installCommand, "pnpm i");
  assert.equal(setup?.buildCommand, "pnpm build");
});

test("a repo setup for another project's repository is ignored", async () => {
  // Silently skipped rather than rejected, but it must never be written.
  const res = await put({
    repoSetups: [
      { repositoryId: foreignRepositoryId, installCommand: "malicious" },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(
    await prisma.repositorySetup.findUnique({
      where: { repositoryId: foreignRepositoryId },
    }),
    null
  );
});

test("a repo setup saved twice is updated in place", async () => {
  await put({ repoSetups: [{ repositoryId, installCommand: "npm i" }] });
  await put({ repoSetups: [{ repositoryId, installCommand: "pnpm i" }] });
  const setups = await prisma.repositorySetup.findMany({
    where: { repositoryId },
  });
  assert.equal(setups.length, 1);
  assert.equal(setups[0].installCommand, "pnpm i");
});

test("config and repo setups can be saved in one request", async () => {
  const res = await put({
    config: validConfig({ region: "fra1" }),
    repoSetups: [{ repositoryId, runCommand: "pnpm dev" }],
  });
  assert.equal(res.status, 200);
  const [config, setup] = await Promise.all([
    prisma.sandboxConfig.findUnique({ where: { projectId } }),
    prisma.repositorySetup.findUnique({ where: { repositoryId } }),
  ]);
  assert.equal(config?.region, "fra1");
  assert.equal(setup?.runCommand, "pnpm dev");
});

// --- git tokens in the panel -------------------------------------------------
// The panel exists so that nothing reaching the sandbox env is invisible in it.
// It used to resolve only the single selected credential, so a project split
// across a self-hosted GitLab and github.com showed GITHUB_TOKEN while
// GITLAB_TOKEN was quietly also on the instance. Panel and launch now share
// resolveGitTokens; these pin that they agree.

async function gitCredentials() {
  await prisma.cloudCredential.createMany({
    data: [
      {
        name: "Github",
        provider: "github",
        data: { token: "ghp_aaaaaaaaaaaa" },
        workspaceId: "ws-setup-test",
      },
      {
        name: "Gitlab",
        provider: "gitlab",
        data: { token: "glpat-bbbbbbbbbbbb" },
        workspaceId: "ws-setup-test",
      },
    ],
  });
}

/** Point the project's repos at the given clone URLs. */
async function repoUrls(...urls: string[]) {
  await prisma.repository.deleteMany({ where: { projectId } });
  for (const [i, repoUrl] of urls.entries()) {
    await prisma.repository.create({
      data: { projectId, name: `repo-${i}`, repoUrl, isMain: i === 0 },
    });
  }
}

const credentialRows = (b: SetupBody) =>
  b.globalEnvVars.filter((v) => v.source === "credential");

test("repos split across hosts list a token for each", async () => {
  await gitCredentials();
  await repoUrls(
    "https://git.example.com/acme/group/api.git",
    "https://github.com/acme-io/charts.git",
  );
  const keys = credentialRows(await body(await get())).map((v) => v.key);
  assert.ok(keys.includes("GITHUB_TOKEN"), "github token listed");
  assert.ok(keys.includes("GITLAB_TOKEN"), "gitlab token listed");
});

test("a single-host project is not shown a token it has no use for", async () => {
  await gitCredentials();
  await repoUrls("https://github.com/acme/app.git");
  const keys = credentialRows(await body(await get())).map((v) => v.key);
  assert.ok(keys.includes("GITHUB_TOKEN"));
  assert.ok(!keys.includes("GITLAB_TOKEN"));
});

test("the derived GITLAB_HOST is listed, and in the clear", async () => {
  await gitCredentials();
  await repoUrls("https://git.example.com/acme/group/api.git");
  const host = credentialRows(await body(await get())).find(
    (v) => v.key === "GITLAB_HOST",
  );
  // A hostname is not a secret, and masking it hides which instance the token
  // was wired to — the one detail that makes the row worth showing.
  assert.equal(host?.valueMasked, "git.example.com");
});

test("a token is still masked, and named by its credential", async () => {
  await gitCredentials();
  await repoUrls("https://git.example.com/acme/group/api.git");
  const row = credentialRows(await body(await get())).find(
    (v) => v.key === "GITLAB_TOKEN",
  );
  assert.ok(row);
  assert.ok(!row.valueMasked.includes("glpat-bbbbbbbbbbbb"), "not leaked");
  assert.match(row.valueMasked, /^•+/);
});

test("a project env var of the same name is reported as the winner", async () => {
  await gitCredentials();
  await repoUrls("https://git.example.com/acme/group/api.git");
  await prisma.projectEnvVar.create({
    data: { projectId, key: "GITLAB_TOKEN", value: "glpat-project-one" },
  });
  const row = credentialRows(await body(await get())).find(
    (v) => v.key === "GITLAB_TOKEN",
  );
  assert.equal(row?.applied, false);
  assert.match(row?.reason ?? "", /overridden by a project env var/);
});

test("a project with no repo urls still shows the selected credential", async () => {
  // Repositories that are still empty shells have no host to derive from; the
  // selection is the only signal there is.
  await gitCredentials();
  await repoUrls();
  await prisma.repository.create({
    data: { projectId, name: "shell", isMain: true },
  });
  const cred = await prisma.cloudCredential.findFirstOrThrow({
    where: { provider: "gitlab" },
  });
  const saved = await put({
    config: validConfig({ githubCredentialId: cred.id }),
  });
  assert.equal(saved.status, 200, "the config saved");
  const keys = credentialRows(await body(await get())).map((v) => v.key);
  assert.ok(keys.includes("GITLAB_TOKEN"));
});

test("the chosen Docker endpoint is kept, and a deleted one reads back as this machine", async () => {
  const endpoint = await prisma.dockerEndpoint.create({
    data: { name: "devbox", host: "ssh://devbox" },
  });
  let res = await put({ config: validConfig({ dockerEndpointId: endpoint.id }) });
  assert.equal(res.status, 200);
  assert.equal((await body(await get())).config?.dockerEndpointId, endpoint.id);

  res = await put({ config: validConfig({ dockerEndpointId: "gone" }) });
  assert.equal(res.status, 200, "a stale id does not fail the save");
  assert.equal((await body(await get())).config?.dockerEndpointId, null);

  await put({ config: validConfig({ dockerEndpointId: endpoint.id }) });
  await prisma.dockerEndpoint.delete({ where: { id: endpoint.id } });
  assert.equal((await body(await get())).config?.dockerEndpointId, null);
});

// --- the repo card's credential is the one a sandbox clones with ------------
// A sandbox used to inject only the sandbox's own "Git token", so a repo card
// showing a working credential still cloned with a dead one.

async function repoWithCredential(name: string, repoUrl: string, credName: string | null, isMain = false) {
  const cred = credName
    ? await prisma.cloudCredential.findFirstOrThrow({ where: { name: credName } })
    : null;
  await prisma.repository.create({
    data: { projectId, name, repoUrl, isMain, gitCredentialId: cred?.id ?? null },
  });
}

test("a repo's own credential wins over the sandbox's git token", async () => {
  await gitCredentials();
  const dead = await prisma.cloudCredential.create({
    data: { name: "dead", provider: "github", data: { token: "ghp_dead" }, workspaceId: "ws-setup-test" },
  });
  await prisma.repository.deleteMany({ where: { projectId } });
  await repoWithCredential("app", "https://github.com/acme/app.git", "Github", true);
  await put({ config: validConfig({ githubCredentialId: dead.id }) });
  const row = credentialRows(await body(await get())).find((v) => v.key === "GITHUB_TOKEN");
  assert.equal(row?.credentialName, "Github");
  assert.equal(row?.note, null);
});

test("without a repo credential the sandbox's git token is the fallback", async () => {
  await gitCredentials();
  const chosen = await prisma.cloudCredential.create({
    data: { name: "chosen", provider: "github", data: { token: "ghp_chosen" }, workspaceId: "ws-setup-test" },
  });
  await prisma.repository.deleteMany({ where: { projectId } });
  await repoWithCredential("app", "https://github.com/acme/app.git", null, true);
  await put({ config: validConfig({ githubCredentialId: chosen.id }) });
  const row = credentialRows(await body(await get())).find((v) => v.key === "GITHUB_TOKEN");
  assert.equal(row?.credentialName, "chosen");
});

test("repos naming different tokens: the main repo's wins, and it says so", async () => {
  await gitCredentials();
  await prisma.cloudCredential.create({
    data: { name: "other", provider: "github", data: { token: "ghp_other" }, workspaceId: "ws-setup-test" },
  });
  await prisma.repository.deleteMany({ where: { projectId } });
  await repoWithCredential("main", "https://github.com/acme/main.git", "other", true);
  await repoWithCredential("lib", "https://github.com/acme/lib.git", "Github");
  const row = credentialRows(await body(await get())).find((v) => v.key === "GITHUB_TOKEN");
  assert.equal(row?.credentialName, "other");
  assert.match(row?.note ?? "", /different tokens/);
});
