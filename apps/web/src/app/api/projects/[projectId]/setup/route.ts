import { prisma, Prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { GLOBAL_ENV_SETTINGS } from "@nexux/sandbox";
import {
  getSandboxReadiness,
  resolveGitTokens,
  resolveClaudeCodeToken,
  SANDBOX_CONFIG_DEFAULTS,
} from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

function maskValue(value: string): string {
  return value.length > 4 ? "••••" + value.slice(-4) : "••••";
}

/** StackNode.env is untyped Json — accept only well-formed {key,value} rows. */
function parseStackEnv(env: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(env)) return [];
  return env.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const { key, value } = row as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || !key.trim()) return [];
    return [{ key, value: typeof value === "string" ? value : "" }];
  });
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const [project, readiness, globalSecrets, stackServices, credentials] =
    await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      include: {
        repositories: {
          include: { setup: true },
          orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
        },
        envVars: { orderBy: { key: "asc" } },
        sandboxConfig: {
          include: { llmCredentials: { select: { credentialId: true } } },
        },
      },
    }),
    getSandboxReadiness(),
    prisma.settings.findMany({
      where: {
        key: { in: Object.keys(GLOBAL_ENV_SETTINGS) },
        isActive: true,
      },
    }),
    prisma.stackNode.findMany({
      where: { projectId },
      select: {
        id: true,
        kind: true,
        name: true,
        image: true,
        runMode: true,
        env: true,
        repositoryId: true,
      },
      orderBy: { name: "asc" },
    }),
    // Credentials are global — every project can use any saved credential.
    prisma.cloudCredential.findMany({
      select: { id: true, name: true, provider: true },
      orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Shared allowlist so the UI shows which global Settings secrets each
  // sandbox will receive. ANTHROPIC_API_KEY is withheld when a Claude Code
  // token exists (the CLI would prefer it for auth).
  const SETTINGS_ENV = GLOBAL_ENV_SETTINGS;
  const projectKeys = new Set(
    project.envVars.filter((v) => !v.repositoryId).map((v) => v.key),
  );
  const hasClaudeToken =
    readiness.hasClaudeCodeToken || projectKeys.has("CLAUDE_CODE_OAUTH_TOKEN");
  type GlobalEnvRow = {
    key: string;
    valueMasked: string;
    applied: boolean;
    reason: string | null;
    source: "settings" | "credential";
    credentialName: string | null;
    /** Worth knowing even when applied — e.g. repos naming different tokens. */
    note?: string | null;
  };
  const settingsEnvVars: GlobalEnvRow[] = globalSecrets
    .filter((row) => row.value?.trim())
    .map((row) => {
      const key = SETTINGS_ENV[row.key];
      const overridden = projectKeys.has(key);
      const withheld = key === "ANTHROPIC_API_KEY" && hasClaudeToken;
      return {
        key,
        valueMasked: maskValue(row.value),
        applied: !overridden && !withheld,
        reason: overridden
          ? "overridden by a project env var"
          : withheld
            ? "withheld — Claude Code token takes auth precedence"
            : null,
        source: "settings" as const,
        credentialName: null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  // Credential-backed values injected at launch — shown alongside the Settings
  // secrets so nothing that reaches the sandbox env is invisible in this panel.
  //
  // Git tokens come from the same resolver the launch uses, not from the single
  // selected credential: a project split across hosts gets one token per host,
  // and resolving only the selection here showed GITHUB_TOKEN while GITLAB_TOKEN
  // was quietly also on the instance.
  const [gitTokens, claudeCred] = await Promise.all([
    resolveGitTokens(
      // Main repo first (the query's order), as the launch orders them: it
      // breaks a tie between repos naming different tokens.
      project.repositories,
      project.sandboxConfig?.githubCredentialId,
    ),
    resolveClaudeCodeToken(project.sandboxConfig?.claudeCredentialId),
  ]);
  const credentialEnvVars: GlobalEnvRow[] = [];
  const pushCredentialVar = (
    key: string | undefined,
    value: string,
    credentialName: string | null,
    // Not everything derived from a credential is a secret: GITLAB_HOST is a
    // hostname, and masking it hides the one detail that says which instance
    // the token was wired to.
    opts: { secret?: boolean; note?: string | null } = {},
  ) => {
    if (!key) return;
    const overridden = projectKeys.has(key);
    credentialEnvVars.push({
      key,
      valueMasked: opts.secret === false ? value : maskValue(value),
      applied: !overridden,
      reason: overridden ? "overridden by a project env var" : null,
      source: "credential",
      credentialName,
      note: opts.note ?? null,
    });
  };
  for (const git of gitTokens) {
    pushCredentialVar(git.envKey, git.token, git.credentialName, {
      note: git.conflict,
    });
    // Derived rather than configured, so without a row here the one value that
    // makes a self-hosted GitLab clone work appears nowhere in the UI.
    if (git.gitlabHost) {
      pushCredentialVar("GITLAB_HOST", git.gitlabHost, git.credentialName, {
        secret: false,
      });
    }
  }
  if (claudeCred) {
    pushCredentialVar(
      "CLAUDE_CODE_OAUTH_TOKEN",
      claudeCred.token,
      claudeCred.name ?? "legacy Settings token",
    );
  }
  const globalEnvVars = [...settingsEnvVars, ...credentialEnvVars];

  const config = project.sandboxConfig
    ? {
        ...project.sandboxConfig,
        llmCredentialIds: project.sandboxConfig.llmCredentials.map(
          (l) => l.credentialId,
        ),
        llmCredentials: undefined,
      }
    : { projectId, ...SANDBOX_CONFIG_DEFAULTS, llmCredentialIds: [] };

  return NextResponse.json({
    config,
    repositories: project.repositories.map((r) => ({
      id: r.id,
      name: r.name,
      repoUrl: r.repoUrl,
      localPath: r.localPath,
      isMain: r.isMain,
      setup: r.setup,
    })),
    globalEnvVars,
    envVars: project.envVars.map((v) => ({
      id: v.id,
      key: v.key,
      repositoryId: v.repositoryId,
      valueMasked: maskValue(v.value),
    })),
    readiness,
    stack: {
      // Unchanged contract: only infra services belong in this list.
      services: stackServices
        .filter((n) => n.kind === "service")
        .map((n) => ({ name: n.name, image: n.image, runMode: n.runMode })),
      // Nodes carrying env on the Stack canvas, offered as an import source in
      // the env editor. Values are masked — the plaintext is fetched per-node
      // only when the user actually imports.
      envSources: stackServices
        .map((n) => {
          const env = parseStackEnv(n.env);
          return {
            nodeId: n.id,
            name: n.name,
            kind: n.kind,
            repositoryId: n.repositoryId,
            vars: env.map((e) => ({
              key: e.key,
              valueMasked: maskValue(e.value),
            })),
          };
        })
        .filter((n) => n.vars.length > 0),
    },
    credentials,
  });
}

const configSchema = z.object({
  // "local" belongs here as much as the cloud providers: launchSandbox reads
  // `sandboxConfig.provider === "local"` to pick the container path, so a
  // schema that refuses the value leaves that branch reachable only through a
  // per-launch override and the drawer's choice never survives a save.
  provider: z.enum(["civo", "aws", "local"]).default("civo"),
  credentialId: z.string().nullable().optional(),
  githubCredentialId: z.string().nullable().optional(),
  claudeCredentialId: z.string().nullable().optional(),
  // provider "local": which machine's Docker (spec 26); null = this one.
  dockerEndpointId: z.string().nullable().optional(),
  region: z.string().min(1),
  size: z.string().min(1),
  diskImage: z.string().min(1),
  branch: z.string().nullable().optional(),
  sshPublicKey: z.string().nullable().optional(),
  installDocker: z.boolean(),
  installNode: z.boolean(),
  installClaudeCode: z.boolean(),
  installAgentBrowser: z.boolean(),
  installBrowserSession: z.boolean().optional(),
  installCloudflared: z.boolean(),
  installTailscale: z.boolean().optional(),
  tailscaleCredentialId: z.string().nullable().optional(),
  includeStackServices: z.boolean(),
  telegramChatId: z.string().nullable().optional(),
  slackChannelId: z.string().nullable().optional(),
  taskTimeoutMinutes: z.number().int().min(5).max(600).nullable().optional(),
  setupScript: z.string().nullable().optional(),
  // Native Claude Code mcpServers shape: { "<name>": { command, args, ... } }
  mcpServers: z
    .record(z.string(), z.record(z.string(), z.unknown()))
    .nullable()
    .optional(),
  agentInstructions: z.string().nullable().optional(),
  claudeModel: z.string().max(100).nullable().optional(),
  brain: z.enum(["claude", "opencode"]).default("claude"),
  openCodeModel: z.string().max(200).nullable().optional(),
  installOpenCode: z.boolean().optional(),
  llmCredentialIds: z.array(z.string().min(1)).max(20).optional(),
  createPr: z.boolean(),
  runTests: z.boolean(),
  captureScreenshots: z.boolean(),
  livePreview: z.boolean(),
  previewPort: z.number().int().min(1).max(65535).nullable(),
});

const putSchema = z.object({
  config: configSchema.optional(),
  repoSetups: z
    .array(
      z.object({
        repositoryId: z.string().min(1),
        installCommand: z.string().nullable().optional(),
        buildCommand: z.string().nullable().optional(),
        runCommand: z.string().nullable().optional(),
        branch: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export async function PUT(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = putSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { repositories: { select: { id: true } } },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { config, repoSetups } = parsed.data;

  if (config) {
    // A stale credential reference must not block saving the rest.
    const checkCredential = async (id: string | null | undefined) =>
      id
        ? ((
            await prisma.cloudCredential.findUnique({
              where: { id },
              select: { id: true },
            })
          )?.id ?? null)
        : null;
    const credentialId = await checkCredential(config.credentialId);
    const githubCredentialId = await checkCredential(config.githubCredentialId);
    const claudeCredentialId = await checkCredential(config.claudeCredentialId);
    const tailscaleCredentialId = await checkCredential(
      config.tailscaleCredentialId,
    );
    // Same rule: a removed endpoint means this machine, not a failed save.
    // Saved whatever the provider: the drawer keeps "local" as its destination
    // rather than in config.provider, and the endpoint only applies when a
    // sandbox launches locally anyway.
    const dockerEndpointId =
      config.dockerEndpointId
        ? ((
            await prisma.dockerEndpoint.findUnique({
              where: { id: config.dockerEndpointId },
              select: { id: true },
            })
          )?.id ?? null)
        : null;

    const data = {
      provider: config.provider,
      credentialId,
      githubCredentialId,
      claudeCredentialId,
      dockerEndpointId,
      region: config.region,
      size: config.size,
      diskImage: config.diskImage,
      branch: config.branch?.trim() || null,
      sshPublicKey: config.sshPublicKey?.trim() || null,
      installDocker: config.installDocker,
      installNode: config.installNode,
      installClaudeCode: config.installClaudeCode,
      installAgentBrowser: config.installAgentBrowser,
      installBrowserSession: Boolean(config.installBrowserSession),
      installCloudflared: config.installCloudflared,
      installTailscale: Boolean(config.installTailscale),
      tailscaleCredentialId,
      includeStackServices: config.includeStackServices,
      telegramChatId: config.telegramChatId?.trim() || null,
      slackChannelId: config.slackChannelId?.trim() || null,
      taskTimeoutMinutes: config.taskTimeoutMinutes ?? null,
      setupScript: config.setupScript?.trim() || null,
      mcpServers:
        config.mcpServers && Object.keys(config.mcpServers).length > 0
          ? (config.mcpServers as Prisma.InputJsonValue)
          : Prisma.DbNull,
      agentInstructions: config.agentInstructions?.trim() || null,
      claudeModel: config.claudeModel?.trim() || null,
      brain: config.brain,
      openCodeModel: config.openCodeModel?.trim() || null,
      // The OpenCode brain always gets its CLI installed.
      installOpenCode:
        Boolean(config.installOpenCode) || config.brain === "opencode",
      createPr: config.createPr,
      runTests: config.runTests,
      captureScreenshots: config.captureScreenshots,
      livePreview: config.livePreview,
      previewPort: config.previewPort,
    };
    const saved = await prisma.sandboxConfig.upsert({
      where: { projectId },
      create: { projectId, ...data },
      update: data,
    });

    if (config.llmCredentialIds) {
      // Replace-set semantics; stale/foreign ids are dropped silently, same
      // spirit as checkCredential above.
      const valid = await prisma.cloudCredential.findMany({
        where: { id: { in: config.llmCredentialIds } },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.sandboxConfigLlmCredential.deleteMany({
          where: { configId: saved.id },
        }),
        prisma.sandboxConfigLlmCredential.createMany({
          data: valid.map((c) => ({
            configId: saved.id,
            credentialId: c.id,
          })),
        }),
      ]);
    }
  }

  if (repoSetups) {
    const validIds = new Set(project.repositories.map((r) => r.id));
    for (const setup of repoSetups) {
      if (!validIds.has(setup.repositoryId)) continue;
      const data = {
        installCommand: setup.installCommand?.trim() || null,
        buildCommand: setup.buildCommand?.trim() || null,
        runCommand: setup.runCommand?.trim() || null,
        branch: setup.branch?.trim() || null,
      };
      await prisma.repositorySetup.upsert({
        where: { repositoryId: setup.repositoryId },
        create: { repositoryId: setup.repositoryId, ...data },
        update: data,
      });
    }
  }

  return NextResponse.json({ ok: true });
}
