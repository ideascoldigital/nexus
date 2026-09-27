/**
 * Database → export document. Spec: `specs/18-config-export-import.md`.
 *
 * Three layers govern what appears here:
 *
 * - **Layer 1, portable configuration** — always exported.
 * - **Layer 2, secrets** — only with `includeSecrets`, and the route seals the
 *   result before it leaves the process.
 * - **Layer 3, machine state** — never exported, `includeSecrets` or not.
 *   `Sandbox` carries `instanceId` / `publicIp` / Terraform `workDir` pointing
 *   at infrastructure the destination cannot manage; importing those rows gives
 *   someone a Destroy button aimed at another install's VM. `SandboxProcess`
 *   holds PIDs, `SandboxTask` run logs, `EmbeddingIndex` bookkeeping for
 *   LanceDB tables that live on disk and do not travel in a JSON — a row
 *   without its table makes the destination believe a project is indexed.
 *   `OAuthState` is an in-flight CSRF nonce; `GitHubIssue` is a re-syncable
 *   cache of a remote system.
 *
 * `ProjectDocumentRevision` is excluded too: revision history is large and its
 * value (undo) is local.
 */

import { prisma } from "@nexux/db";

import { commonRoot, relativise } from "./paths";
import {
  EXPORT_VERSION,
  type ExportDocument,
  type ExportProject,
} from "./schema";

export type CollectOptions = {
  /** All projects, or a named subset. */
  scope: { kind: "all" } | { kind: "project"; projectIds: string[] };
  includeSecrets: boolean;
  includeConversations: boolean;
  /**
   * Structure only, for handing to a teammate: keeps repositories, stack,
   * sandbox config, brain, env var *keys* and the agent/skill joins; drops the
   * work product (features, dev phases, definition phases, documents,
   * schedules, conversations). Always secretless — the route enforces it.
   */
  template?: boolean;
  /** Overrides the computed longest-common-prefix of host paths. */
  pathRoot?: string;
};

/**
 * The last applied migration, read from the custom runner's table
 * (`packages/db/src/migrate.ts`). Read rather than hardcoded — it is the only
 * value that is true by construction. Import refuses a file whose schema is
 * newer than the destination's.
 */
export async function currentSchemaVersion(): Promise<string> {
  try {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM _nexux_migrations ORDER BY name DESC LIMIT 1
    `;
    return rows[0]?.name ?? "";
  } catch {
    // Table absent when NEXUX_MIGRATIONS_DIR was never set (prisma db push).
    return "";
  }
}

/** Conversations with their messages, for the opt-in `includeConversations`. */
function fetchConversations(projectIds: string[]) {
  return prisma.conversation.findMany({
    where: { projectId: { in: projectIds } },
    orderBy: { createdAt: "asc" },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
}

/** Secret-bearing fields collapse to null unless secrets were asked for. */
const secretOr = <T>(value: T, include: boolean): T | null =>
  include ? value : null;

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;

export async function collectExport(
  options: CollectOptions,
): Promise<ExportDocument> {
  const { scope, includeSecrets, includeConversations } = options;
  const template = options.template === true;

  const projectWhere =
    scope.kind === "project" ? { id: { in: scope.projectIds } } : {};

  const projectRows = await prisma.project.findMany({
    where: projectWhere,
    orderBy: { createdAt: "asc" },
    include: {
      repositories: { orderBy: { createdAt: "asc" }, include: { setup: true } },
      stackNodes: { orderBy: { createdAt: "asc" }, include: { seed: true } },
      stackEdges: { orderBy: { id: "asc" } },
      sandboxConfig: { include: { llmCredentials: true } },
      envVars: { orderBy: [{ key: "asc" }, { id: "asc" }] },
      brain: true,
      phases: { orderBy: { order: "asc" } },
      devPhases: { orderBy: { order: "asc" } },
      features: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      document: { include: { sections: { orderBy: { order: "asc" } } } },
      taskSchedules: { orderBy: { createdAt: "asc" } },
      projectSkills: true,
      projectAgents: true,
      agentSkills: true,
    },
  });

  // Conversations are fetched separately rather than as a conditional
  // `include`: Prisma types the relation off the literal, so a ternary there
  // erases `messages` from the result type for both branches.
  const conversationsByProject = new Map<
    string,
    Awaited<ReturnType<typeof fetchConversations>>
  >();
  if (includeConversations && !template) {
    const rows = await fetchConversations(projectRows.map((p) => p.id));
    for (const row of rows) {
      const list = conversationsByProject.get(row.projectId) ?? [];
      list.push(row);
      conversationsByProject.set(row.projectId, list);
    }
  }

  // pathRoot has to be known before any path is written, so it is computed
  // from the rows first and the relativisation happens in a second pass.
  const hostPaths = projectRows.flatMap((p) => [
    ...(p.workspacePath ? [p.workspacePath] : []),
    ...p.repositories.flatMap((r) => (r.localPath ? [r.localPath] : [])),
  ]);
  const pathRoot = options.pathRoot ?? commonRoot(hostPaths);

  const projectIds = projectRows.map((p) => p.id);
  const workspaceIds = [...new Set(projectRows.map((p) => p.workspaceId))];

  // Catalogs: scoped to the workspaces actually in play. A project-scoped
  // export still carries the agents/skills its joins reference, or the import
  // lands rows pointing at nothing.
  const catalogWhere =
    scope.kind === "project" ? { workspaceId: { in: workspaceIds } } : {};

  const [workspaces, credentials, settings, agents, skills, tools] =
    await Promise.all([
      prisma.workspace.findMany({
        where: scope.kind === "project" ? { id: { in: workspaceIds } } : {},
        orderBy: { createdAt: "asc" },
      }),
      prisma.cloudCredential.findMany({
        where: catalogWhere,
        orderBy: [{ provider: "asc" }, { createdAt: "asc" }],
      }),
      includeSecrets
        ? prisma.settings.findMany({ orderBy: { key: "asc" } })
        : Promise.resolve([]),
      prisma.agent.findMany({ where: catalogWhere, orderBy: { name: "asc" } }),
      prisma.skill.findMany({ where: catalogWhere, orderBy: { name: "asc" } }),
      // Tool has no workspace column — it is install-global.
      prisma.tool.findMany({ orderBy: { name: "asc" } }),
    ]);

  const projects: ExportProject[] = projectRows.map((p) => ({
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    description: p.description,
    workspacePath: relativise(p.workspacePath, pathRoot),
    bootstrapType: p.bootstrapType,
    repositories: p.repositories.map((r) => ({
      id: r.id,
      name: r.name,
      repoUrl: r.repoUrl,
      localPath: relativise(r.localPath, pathRoot),
      isMain: r.isMain,
      // Carried so a moved install still clones as the right account. Unlike
      // localPath this is not host-specific — credentials travel in the same
      // file — and losing it silently returns the repo to the first-token
      // guess, which is what makes a private repo fail to clone.
      gitCredentialId: r.gitCredentialId,
      // cloneStatus is deliberately absent: it describes this host's disk.
      setup: r.setup
        ? {
            id: r.setup.id,
            installCommand: r.setup.installCommand,
            buildCommand: r.setup.buildCommand,
            runCommand: r.setup.runCommand,
            branch: r.setup.branch,
          }
        : null,
    })),
    stack: {
      nodes: p.stackNodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        repositoryId: n.repositoryId,
        name: n.name,
        runMode: n.runMode,
        image: n.image,
        dockerfile: n.dockerfile,
        buildContext: n.buildContext,
        command: n.command,
        installCommand: n.installCommand,
        buildCommand: n.buildCommand,
        localCommand: n.localCommand,
        stopCommand: n.stopCommand,
        workdir: n.workdir,
        managesServices: n.managesServices,
        ports: n.ports,
        // Canvas `env` can hold secrets the user typed into a node. It follows
        // the same rule as ProjectEnvVar rather than riding along because it
        // happens to be a Json column.
        env: secretOr(n.env, includeSecrets),
        volumes: n.volumes,
        detection: n.detection,
        phases: n.phases,
        posX: n.posX,
        posY: n.posY,
        // Metadata only — the file never travels in an export (spec 29), and
        // a template is structure, not anyone's data.
        seed:
          n.seed && !template
            ? {
                fileName: n.seed.fileName,
                format: n.seed.format,
                sizeBytes: Number(n.seed.sizeBytes),
                sha256: n.seed.sha256,
                sensitive: n.seed.sensitive,
              }
            : null,
      })),
      edges: p.stackEdges.map((e) => ({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
      })),
    },
    sandboxConfig: p.sandboxConfig
      ? {
          id: p.sandboxConfig.id,
          provider: p.sandboxConfig.provider,
          credentialId: p.sandboxConfig.credentialId,
          githubCredentialId: p.sandboxConfig.githubCredentialId,
          claudeCredentialId: p.sandboxConfig.claudeCredentialId,
          llmCredentialIds: p.sandboxConfig.llmCredentials.map(
            (l) => l.credentialId,
          ),
          region: p.sandboxConfig.region,
          size: p.sandboxConfig.size,
          diskImage: p.sandboxConfig.diskImage,
          branch: p.sandboxConfig.branch,
          sshPublicKey: p.sandboxConfig.sshPublicKey,
          installDocker: p.sandboxConfig.installDocker,
          installNode: p.sandboxConfig.installNode,
          installClaudeCode: p.sandboxConfig.installClaudeCode,
          installAgentBrowser: p.sandboxConfig.installAgentBrowser,
          installCloudflared: p.sandboxConfig.installCloudflared,
          installTailscale: p.sandboxConfig.installTailscale,
          tailscaleCredentialId: p.sandboxConfig.tailscaleCredentialId,
          includeStackServices: p.sandboxConfig.includeStackServices,
          telegramChatId: p.sandboxConfig.telegramChatId,
          setupScript: p.sandboxConfig.setupScript,
          // mcpServers entries can carry API keys in `env` / `headers`.
          mcpServers: secretOr(p.sandboxConfig.mcpServers, includeSecrets),
          brain: p.sandboxConfig.brain,
          agentInstructions: p.sandboxConfig.agentInstructions,
          claudeModel: p.sandboxConfig.claudeModel,
          openCodeModel: p.sandboxConfig.openCodeModel,
          installOpenCode: p.sandboxConfig.installOpenCode,
          createPr: p.sandboxConfig.createPr,
          runTests: p.sandboxConfig.runTests,
          captureScreenshots: p.sandboxConfig.captureScreenshots,
          livePreview: p.sandboxConfig.livePreview,
          previewPort: p.sandboxConfig.previewPort,
        }
      : null,
    envVars: p.envVars.map((v) => ({
      id: v.id,
      key: v.key,
      repositoryId: v.repositoryId,
      value: secretOr(v.value, includeSecrets),
    })),
    brain: p.brain
      ? {
          id: p.brain.id,
          provider: p.brain.provider,
          model: p.brain.model,
          config: p.brain.config,
        }
      : null,
    // Template exports carry structure, not work product: the definition
    // phases, roadmap, features, document and schedules describe *this*
    // project's progress, which is exactly what a teammate starting fresh
    // should not inherit.
    phases: template
      ? []
      : p.phases.map((ph) => ({
          id: ph.id,
          key: ph.key,
          order: ph.order,
          status: ph.status,
          title: ph.title,
          summary: ph.summary,
        })),
    devPhases: template ? [] : p.devPhases.map((d) => ({
      id: d.id,
      name: d.name,
      goal: d.goal,
      order: d.order,
      status: d.status,
      sourceSectionKeys: d.sourceSectionKeys,
    })),
    features: template ? [] : p.features.map((f) => ({
      id: f.id,
      devPhaseId: f.devPhaseId,
      title: f.title,
      description: f.description,
      status: f.status,
      priority: f.priority,
      aiRefinement: f.aiRefinement,
      sourceSectionKeys: f.sourceSectionKeys,
      // Paths to blobs staged on the source host; the files do not travel.
      attachments: f.attachments,
      order: f.order,
    })),
    document: !template && p.document
      ? {
          id: p.document.id,
          version: p.document.version,
          status: p.document.status,
          sections: p.document.sections.map((s) => ({
            id: s.id,
            phaseKey: s.phaseKey,
            key: s.key,
            title: s.title,
            content: s.content,
            ownerRole: s.ownerRole,
            order: s.order,
            status: s.status,
          })),
        }
      : null,
    schedules: template ? [] : p.taskSchedules.map((s) => ({
      id: s.id,
      featureId: s.featureId,
      prompt: s.prompt,
      provider: s.provider,
      ephemeral: s.ephemeral,
      cron: s.cron,
      runAt: iso(s.runAt),
      enabled: s.enabled,
    })),
    skillIds: p.projectSkills.map((j) => j.skillId),
    agentIds: p.projectAgents.map((j) => j.agentId),
    agentSkills: p.agentSkills.map((j) => ({
      agentId: j.agentId,
      skillId: j.skillId,
    })),
    conversations: (conversationsByProject.get(p.id) ?? []).map((c) => ({
      id: c.id,
      featureId: c.featureId,
      sessionId: c.sessionId,
      name: c.name,
      status: c.status,
      agentId: c.agentId,
      model: c.model,
      permissionMode: c.permissionMode,
      systemPrompt: c.systemPrompt,
      totalCostUsd: c.totalCostUsd,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        messageType: m.messageType,
        claudeMessageId: m.claudeMessageId,
        costUsd: m.costUsd,
        agentRole: m.agentRole,
        createdAt: m.createdAt.toISOString(),
      })),
    })),
  }));

  return {
    meta: {
      nexuxExportVersion: EXPORT_VERSION,
      schemaVersion: await currentSchemaVersion(),
      exportedAt: new Date().toISOString(),
      sourceMode: process.env.NEXUX_MODE === "server" ? "server" : "local",
      pathRoot,
      includesSecrets: includeSecrets,
      includesConversations: includeConversations && !template,
      template: template || undefined,
      scope:
        scope.kind === "project"
          ? { kind: "project", projectIds }
          : { kind: "all" },
    },
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      icon: w.icon,
      logo: w.logo,
    })),
    // Shells always, secrets conditionally: the credential FKs on SandboxConfig
    // encode which of two tokens a project pinned (D-28). That is configuration
    // and must survive a secretless export, or the destination silently falls
    // back to "first credential of this provider, oldest wins".
    credentials: credentials.map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      name: c.name,
      provider: c.provider,
      data: secretOr(c.data, includeSecrets),
    })),
    settings: settings.map((s) => ({
      id: s.id,
      key: s.key,
      value: s.value,
      provider: s.provider,
      isActive: s.isActive,
    })),
    catalogs: {
      agents: agents.map((a) => ({
        id: a.id,
        workspaceId: a.workspaceId,
        name: a.name,
        description: a.description,
        systemPrompt: a.systemPrompt,
        model: a.model,
        color: a.color,
        isBuiltIn: a.isBuiltIn,
        filePath: a.filePath,
      })),
      skills: skills.map((s) => ({
        id: s.id,
        workspaceId: s.workspaceId,
        name: s.name,
        description: s.description,
        source: s.source,
        scope: s.scope,
        path: s.path,
        body: s.body,
        isBuiltIn: s.isBuiltIn,
      })),
      tools: tools.map((t) => ({
        id: t.id,
        name: t.name,
        provider: t.provider,
        type: t.type,
        command: t.command,
        endpoint: t.endpoint,
        description: t.description,
        schema: t.schema,
      })),
    },
    projects,
  };
}

/** Filename for the download, e.g. `nexux-export-20260802-1430.json`. */
export function exportFilename(
  encrypted: boolean,
  now = new Date(),
  template = false,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const kind = template ? "template" : "export";
  return `nexux-${kind}-${stamp}.json${encrypted ? ".enc" : ""}`;
}
