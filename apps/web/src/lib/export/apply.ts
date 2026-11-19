/**
 * Export document → database. Spec: `specs/18-config-export-import.md`.
 *
 * The dry run and the real import are **one code path**, parameterised on
 * `dryRun`. A preview computed by different code than the write is a preview
 * that eventually lies, and this preview is the only thing standing between the
 * user and a destructive `replace`.
 *
 * Writes are sequential rather than one transaction, matching the reasoning
 * already recorded in `env-vars/bulk`: SQLite serialises writes anyway, and a
 * partial import that reports how far it got beats a rollback that hides which
 * row was malformed.
 */

import fs from "fs";

import { Prisma, prisma } from "@nexux/db";

import { currentSchemaVersion } from "./collect";
import { resolvePortable } from "./paths";
import {
  EXPORT_VERSION,
  type ExportDocument,
  type ExportProject,
} from "./schema";

export type ImportMode = "merge" | "replace";

export type ApplyOptions = {
  mode: ImportMode;
  /** Destination root for `{ root: "pathRoot" }` entries. */
  pathRoot?: string;
  dryRun: boolean;
};

export type Counts = { create: number; update: number; delete: number };

export type ProjectPlan = {
  id: string;
  name: string;
  action: "create" | "update";
  counts: Record<string, Counts>;
  paths: Array<{
    field: string;
    resolved: string | null;
    existsOnDisk: boolean;
    /** Set when the source path sat outside its pathRoot and came through raw. */
    absolute?: boolean;
  }>;
};

export type ImportPlan = {
  ok: boolean;
  dryRun: boolean;
  mode: ImportMode;
  schemaVersion: {
    file: string;
    destination: string;
    verdict: "equal" | "destination-newer" | "destination-older" | "unknown";
  };
  workspaces: Counts;
  credentials: Counts & { needsSecret: string[] };
  settings: Counts;
  catalogs: Record<string, Counts>;
  projects: ProjectPlan[];
  envVars: { needsValue: number };
  schedules: { importedDisabled: number };
  warnings: string[];
  errors: string[];
};

const zero = (): Counts => ({ create: 0, update: 0, delete: 0 });

/**
 * Prisma's Json input types differ between nullable and non-nullable columns
 * (`DbNull` is only valid on the former), and the document carries both. The
 * values themselves are opaque here — the canvas and each provider own their
 * shape — so this narrows to the one thing that matters: null becomes Prisma's
 * JSON null rather than "unset".
 */
const json = (v: unknown) =>
  (v ?? Prisma.JsonNull) as Prisma.InputJsonValue;

/**
 * Compare the file's schema version against this install's.
 *
 * A destination that is *older* is refused: the file may carry columns that do
 * not exist here yet, and silently dropping them produces a project that looks
 * imported and is not. Newer only warns — migrations are additive in practice,
 * so missing columns take their defaults.
 */
function compareSchema(
  file: string,
  destination: string,
): ImportPlan["schemaVersion"] {
  if (!file || !destination) {
    return { file, destination, verdict: "unknown" };
  }
  if (file === destination) return { file, destination, verdict: "equal" };
  return {
    file,
    destination,
    verdict: destination > file ? "destination-newer" : "destination-older",
  };
}

function exists(p: string | null): boolean {
  if (!p) return false;
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Apply a document. Returns the plan either way; with `dryRun` nothing is
 * written, and every lookup still runs so the counts are real.
 */
export async function applyImport(
  doc: ExportDocument,
  options: ApplyOptions,
): Promise<ImportPlan> {
  const { mode, dryRun } = options;
  const warnings: string[] = [];
  const errors: string[] = [];

  const destinationSchema = await currentSchemaVersion();
  const schemaVersion = compareSchema(doc.meta.schemaVersion, destinationSchema);

  if (doc.meta.nexuxExportVersion > EXPORT_VERSION) {
    errors.push(
      `Export version ${doc.meta.nexuxExportVersion} is newer than this install supports (${EXPORT_VERSION})`,
    );
  }
  if (schemaVersion.verdict === "destination-older") {
    errors.push(
      `The file was written by a newer schema (${schemaVersion.file}); this install is at ${schemaVersion.destination}. Upgrade before importing.`,
    );
  }
  if (schemaVersion.verdict === "destination-newer") {
    warnings.push(
      `The file predates this install's schema (${schemaVersion.file} → ${schemaVersion.destination}); new columns will take their defaults.`,
    );
  }
  if (schemaVersion.verdict === "unknown") {
    warnings.push(
      "Schema version could not be compared (one side has no migration record).",
    );
  }

  // A pathRoot-relative entry with no destination root is unresolvable, and
  // guessing a location would produce sandboxes that bind-mount the wrong
  // directory. Reported here rather than discovered at provision time.
  const needsRoot = doc.projects.some(
    (p) =>
      p.workspacePath?.root === "pathRoot" ||
      p.repositories.some((r) => r.localPath?.root === "pathRoot"),
  );
  const pathRoot = options.pathRoot ?? "";
  if (needsRoot && !pathRoot) {
    errors.push(
      `The file contains paths relative to "${doc.meta.pathRoot}". Provide a pathRoot for this machine.`,
    );
  }

  const plan: ImportPlan = {
    ok: true,
    dryRun,
    mode,
    schemaVersion,
    workspaces: zero(),
    credentials: { ...zero(), needsSecret: [] },
    settings: zero(),
    catalogs: { agents: zero(), skills: zero(), tools: zero() },
    projects: [],
    envVars: { needsValue: 0 },
    schedules: { importedDisabled: 0 },
    warnings,
    errors,
  };

  // Plan first, write second: a fatal error must not leave half a project
  // written. Everything below this point is scoped by `write`.
  const write = !dryRun && errors.length === 0;

  // ---- workspaces --------------------------------------------------------
  for (const ws of doc.workspaces) {
    const existing = await prisma.workspace.findUnique({
      where: { id: ws.id },
      select: { id: true },
    });
    if (existing) plan.workspaces.update++;
    else plan.workspaces.create++;
    if (!write) continue;
    await prisma.workspace.upsert({
      where: { id: ws.id },
      create: { id: ws.id, name: ws.name, icon: ws.icon, logo: ws.logo },
      update: { name: ws.name, icon: ws.icon, logo: ws.logo },
    });
  }

  // ---- credentials -------------------------------------------------------
  // Shells carry identity with `data: null`. Importing one must never blank an
  // existing secret on the destination — a secretless file would otherwise
  // wipe the very tokens it is trying to preserve the references to.
  for (const cred of doc.credentials) {
    const existing = await prisma.cloudCredential.findUnique({
      where: { id: cred.id },
      select: { id: true, data: true },
    });
    const hasSecretHere =
      cred.data !== null ||
      (existing?.data != null &&
        Object.keys(existing.data as Record<string, unknown>).length > 0);
    if (!hasSecretHere) plan.credentials.needsSecret.push(cred.name);

    if (existing) plan.credentials.update++;
    else plan.credentials.create++;
    if (!write) continue;

    await prisma.cloudCredential.upsert({
      where: { id: cred.id },
      create: {
        id: cred.id,
        workspaceId: cred.workspaceId,
        name: cred.name,
        provider: cred.provider,
        data: json(cred.data ?? {}),
      },
      update: {
        workspaceId: cred.workspaceId,
        name: cred.name,
        provider: cred.provider,
        // Only overwrite when the file actually carries a secret.
        ...(cred.data !== null ? { data: json(cred.data) } : {}),
      },
    });
  }

  // ---- settings ----------------------------------------------------------
  for (const setting of doc.settings) {
    if (setting.value === null) continue;
    const existing = await prisma.settings.findUnique({
      where: { key: setting.key },
      select: { id: true },
    });
    // The Telegram bot long-polls as a singleton: two installs holding the
    // same token fight over updates. Warn rather than pick a winner — deciding
    // which host owns the bot is the user's call, not ours.
    if (existing && setting.key.startsWith("telegram_")) {
      warnings.push(
        `Destination already has a ${setting.key} setting — two installs sharing a Telegram token will fight over updates.`,
      );
    }
    if (existing) plan.settings.update++;
    else plan.settings.create++;
    if (!write) continue;
    await prisma.settings.upsert({
      where: { key: setting.key },
      create: {
        id: setting.id,
        key: setting.key,
        value: setting.value,
        provider: setting.provider,
        isActive: setting.isActive,
      },
      update: { value: setting.value, provider: setting.provider },
    });
  }

  // ---- catalogs ----------------------------------------------------------
  // Agent.name and Skill.name are globally @unique, so a same-named row under a
  // different id is a genuine conflict: upserting by id would throw. The name
  // wins (it is what joins and `.claude` context reference), and the file's id
  // is remapped onto the incumbent for this import's joins.
  const agentIdMap = new Map<string, string>();
  for (const agent of doc.catalogs.agents) {
    const [byId, byName] = await Promise.all([
      prisma.agent.findUnique({ where: { id: agent.id }, select: { id: true } }),
      prisma.agent.findUnique({
        where: { name: agent.name },
        select: { id: true },
      }),
    ]);
    if (byName && byName.id !== agent.id) {
      agentIdMap.set(agent.id, byName.id);
      warnings.push(
        `Agent "${agent.name}" already exists here under a different id — the existing one is kept.`,
      );
      plan.catalogs.agents.update++;
      if (write) {
        await prisma.agent.update({
          where: { id: byName.id },
          data: {
            description: agent.description,
            systemPrompt: agent.systemPrompt,
            model: agent.model,
            color: agent.color,
          },
        });
      }
      continue;
    }
    if (byId) plan.catalogs.agents.update++;
    else plan.catalogs.agents.create++;
    if (!write) continue;
    await prisma.agent.upsert({
      where: { id: agent.id },
      create: {
        id: agent.id,
        workspaceId: agent.workspaceId,
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        color: agent.color,
        isBuiltIn: agent.isBuiltIn,
        filePath: agent.filePath,
      },
      update: {
        name: agent.name,
        description: agent.description,
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        color: agent.color,
      },
    });
  }

  const skillIdMap = new Map<string, string>();
  for (const skill of doc.catalogs.skills) {
    const [byId, byName] = await Promise.all([
      prisma.skill.findUnique({ where: { id: skill.id }, select: { id: true } }),
      prisma.skill.findUnique({
        where: { name: skill.name },
        select: { id: true },
      }),
    ]);
    if (byName && byName.id !== skill.id) {
      skillIdMap.set(skill.id, byName.id);
      warnings.push(
        `Skill "${skill.name}" already exists here under a different id — the existing one is kept.`,
      );
      plan.catalogs.skills.update++;
      if (write) {
        await prisma.skill.update({
          where: { id: byName.id },
          data: {
            description: skill.description,
            source: skill.source,
            scope: skill.scope,
            path: skill.path,
            body: skill.body,
          },
        });
      }
      continue;
    }
    if (byId) plan.catalogs.skills.update++;
    else plan.catalogs.skills.create++;
    if (!write) continue;
    await prisma.skill.upsert({
      where: { id: skill.id },
      create: {
        id: skill.id,
        workspaceId: skill.workspaceId,
        name: skill.name,
        description: skill.description,
        source: skill.source,
        scope: skill.scope,
        path: skill.path,
        body: skill.body,
        isBuiltIn: skill.isBuiltIn,
      },
      update: {
        description: skill.description,
        source: skill.source,
        scope: skill.scope,
        path: skill.path,
        body: skill.body,
      },
    });
  }

  for (const tool of doc.catalogs.tools) {
    const existing = await prisma.tool.findUnique({
      where: { id: tool.id },
      select: { id: true },
    });
    if (existing) plan.catalogs.tools.update++;
    else plan.catalogs.tools.create++;
    if (!write) continue;
    await prisma.tool.upsert({
      where: { id: tool.id },
      create: {
        id: tool.id,
        name: tool.name,
        provider: tool.provider,
        type: tool.type,
        command: tool.command,
        endpoint: tool.endpoint,
        description: tool.description,
        schema: json(tool.schema),
      },
      update: {
        name: tool.name,
        provider: tool.provider,
        type: tool.type,
        command: tool.command,
        endpoint: tool.endpoint,
        description: tool.description,
        schema: json(tool.schema),
      },
    });
  }

  // ---- projects ----------------------------------------------------------
  for (const project of doc.projects) {
    plan.projects.push(
      await applyProject(project, {
        write,
        pathRoot,
        mode,
        plan,
        agentIdMap,
        skillIdMap,
      }),
    );
  }

  plan.ok = errors.length === 0;
  return plan;
}

type ProjectCtx = {
  write: boolean;
  pathRoot: string;
  mode: ImportMode;
  plan: ImportPlan;
  agentIdMap: Map<string, string>;
  skillIdMap: Map<string, string>;
};

async function applyProject(
  p: ExportProject,
  ctx: ProjectCtx,
): Promise<ProjectPlan> {
  const { write, pathRoot, mode, plan } = ctx;
  const counts: Record<string, Counts> = {
    repositories: zero(),
    stackNodes: zero(),
    stackEdges: zero(),
    // Counted so the preview *shows* the sandbox settings travelling —
    // invisible, "did my sandbox config make it?" has no answer.
    sandboxConfig: zero(),
    envVars: zero(),
    features: zero(),
    devPhases: zero(),
    phases: zero(),
    documentSections: zero(),
    schedules: zero(),
    conversations: zero(),
  };

  const existing = await prisma.project.findUnique({
    where: { id: p.id },
    select: { id: true },
  });

  const workspacePath = resolvePortable(p.workspacePath, pathRoot);
  const paths: ProjectPlan["paths"] = [];
  if (p.workspacePath) {
    paths.push({
      field: "workspacePath",
      resolved: workspacePath,
      existsOnDisk: exists(workspacePath),
      ...(p.workspacePath.root === "absolute" ? { absolute: true } : {}),
    });
  }

  if (write) {
    await prisma.project.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        workspaceId: p.workspaceId,
        name: p.name,
        description: p.description,
        workspacePath,
        bootstrapType: p.bootstrapType,
      },
      update: {
        workspaceId: p.workspaceId,
        name: p.name,
        description: p.description,
        workspacePath,
        bootstrapType: p.bootstrapType,
      },
    });
  }

  // ---- repositories ------------------------------------------------------
  for (const repo of p.repositories) {
    const local = resolvePortable(repo.localPath, pathRoot);
    if (repo.localPath) {
      paths.push({
        field: `repository:${repo.name}`,
        resolved: local,
        existsOnDisk: exists(local),
        ...(repo.localPath.root === "absolute" ? { absolute: true } : {}),
      });
    }
    const row = await prisma.repository.findUnique({
      where: { id: repo.id },
      select: { id: true },
    });
    if (row) counts.repositories.update++;
    else counts.repositories.create++;
    if (!write) continue;

    // A credential the destination does not have would fail the foreign key and
    // take the whole import down. Dropping to null instead returns the repo to
    // the provider-wide fallback — the same behaviour as never having set one.
    const gitCredentialId = repo.gitCredentialId
      ? ((
          await prisma.cloudCredential.findUnique({
            where: { id: repo.gitCredentialId },
            select: { id: true },
          })
        )?.id ?? null)
      : null;

    await prisma.repository.upsert({
      where: { id: repo.id },
      create: {
        id: repo.id,
        projectId: p.id,
        name: repo.name,
        repoUrl: repo.repoUrl,
        localPath: local,
        isMain: repo.isMain,
        gitCredentialId,
        // Never imported as "ready": the checkout is this host's business.
        cloneStatus: "pending",
      },
      update: {
        name: repo.name,
        repoUrl: repo.repoUrl,
        localPath: local,
        isMain: repo.isMain,
        gitCredentialId,
      },
    });

    if (repo.setup) {
      await prisma.repositorySetup.upsert({
        // repositoryId is @unique — keying on it rather than the row id keeps
        // a destination-side setup row from colliding under a different id.
        where: { repositoryId: repo.id },
        create: {
          id: repo.setup.id,
          repositoryId: repo.id,
          installCommand: repo.setup.installCommand,
          buildCommand: repo.setup.buildCommand,
          runCommand: repo.setup.runCommand,
          branch: repo.setup.branch,
        },
        update: {
          installCommand: repo.setup.installCommand,
          buildCommand: repo.setup.buildCommand,
          runCommand: repo.setup.runCommand,
          branch: repo.setup.branch,
        },
      });
    }
  }

  // ---- stack canvas ------------------------------------------------------
  // Nodes before edges (edges FK both ends), and edges deleted before nodes on
  // replace for the same reason.
  for (const node of p.stack.nodes) {
    const row = await prisma.stackNode.findUnique({
      where: { id: node.id },
      select: { id: true },
    });
    if (row) counts.stackNodes.update++;
    else counts.stackNodes.create++;
    // A seed's file is never in an export (spec 29). Say so, unless this
    // install already holds the very same file for the node.
    if (node.seed) {
      const here = await prisma.seedData.findUnique({
        where: { stackNodeId: node.id },
        select: { sha256: true },
      });
      if (here?.sha256 !== node.seed.sha256) {
        const mb = node.seed.sizeBytes / (1024 * 1024);
        plan.warnings.push(
          `Seed data for "${node.name}" in ${p.name} (${node.seed.fileName}, ${mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(node.seed.sizeBytes / 1024))} KB`}) is not part of an export — attach it again on that project's Stack canvas.`,
        );
      }
    }
    if (!write) continue;
    const data = {
      kind: node.kind,
      repositoryId: node.repositoryId,
      name: node.name,
      runMode: node.runMode,
      image: node.image,
      dockerfile: node.dockerfile,
      buildContext: node.buildContext,
      command: node.command,
      installCommand: node.installCommand,
      buildCommand: node.buildCommand,
      localCommand: node.localCommand,
      stopCommand: node.stopCommand,
      workdir: node.workdir,
      managesServices: node.managesServices,
      ports: json(node.ports),
      volumes: json(node.volumes),
      detection: json(node.detection),
      phases: json(node.phases),
      posX: node.posX,
      posY: node.posY,
    };
    await prisma.stackNode.upsert({
      where: { id: node.id },
      create: {
        id: node.id,
        projectId: p.id,
        ...data,
        // A secretless export nulls node env; keep whatever is here already
        // rather than clearing the canvas's own values.
        ...(node.env !== null ? { env: json(node.env) } : {}),
      },
      update: {
        ...data,
        ...(node.env !== null ? { env: json(node.env) } : {}),
      },
    });
  }

  for (const edge of p.stack.edges) {
    const row = await prisma.stackEdge.findUnique({
      where: { id: edge.id },
      select: { id: true },
    });
    if (row) counts.stackEdges.update++;
    else counts.stackEdges.create++;
    if (!write) continue;
    await prisma.stackEdge.upsert({
      where: { id: edge.id },
      create: {
        id: edge.id,
        projectId: p.id,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
      },
      update: { sourceId: edge.sourceId, targetId: edge.targetId },
    });
  }

  // ---- env vars ----------------------------------------------------------
  // A null value means the file was secretless. The row is still written with
  // "" so the destination gets a checklist of keys to fill, but an existing
  // value here is never blanked by it.
  for (const v of p.envVars) {
    const row = await prisma.projectEnvVar.findUnique({
      where: { id: v.id },
      select: { id: true, value: true },
    });
    if (v.value === null && !row?.value) plan.envVars.needsValue++;
    if (row) counts.envVars.update++;
    else counts.envVars.create++;
    if (!write) continue;
    await prisma.projectEnvVar.upsert({
      where: { id: v.id },
      create: {
        id: v.id,
        projectId: p.id,
        repositoryId: v.repositoryId,
        key: v.key,
        value: v.value ?? "",
      },
      update: {
        repositoryId: v.repositoryId,
        key: v.key,
        ...(v.value !== null ? { value: v.value } : {}),
      },
    });
  }

  // ---- sandbox config ----------------------------------------------------
  if (p.sandboxConfig) {
    const c = p.sandboxConfig;
    const configExisting = await prisma.sandboxConfig.findUnique({
      where: { projectId: p.id },
      select: { id: true },
    });
    if (configExisting) counts.sandboxConfig.update++;
    else counts.sandboxConfig.create++;
    const data = {
      provider: c.provider,
      credentialId: c.credentialId,
      githubCredentialId: c.githubCredentialId,
      claudeCredentialId: c.claudeCredentialId,
      region: c.region,
      size: c.size,
      diskImage: c.diskImage,
      branch: c.branch,
      sshPublicKey: c.sshPublicKey,
      installDocker: c.installDocker,
      installNode: c.installNode,
      installClaudeCode: c.installClaudeCode,
      installAgentBrowser: c.installAgentBrowser,
      installCloudflared: c.installCloudflared,
      installTailscale: c.installTailscale,
      tailscaleCredentialId: c.tailscaleCredentialId,
      includeStackServices: c.includeStackServices,
      telegramChatId: c.telegramChatId,
      setupScript: c.setupScript,
      brain: c.brain,
      agentInstructions: c.agentInstructions,
      claudeModel: c.claudeModel,
      openCodeModel: c.openCodeModel,
      installOpenCode: c.installOpenCode,
      createPr: c.createPr,
      runTests: c.runTests,
      captureScreenshots: c.captureScreenshots,
      livePreview: c.livePreview,
      previewPort: c.previewPort,
    };
    if (write) {
      await prisma.sandboxConfig.upsert({
        // projectId is @unique — key on it, not the row id.
        where: { projectId: p.id },
        create: {
          id: c.id,
          projectId: p.id,
          ...data,
          ...(c.mcpServers !== null ? { mcpServers: json(c.mcpServers) } : {}),
        },
        update: {
          ...data,
          ...(c.mcpServers !== null ? { mcpServers: json(c.mcpServers) } : {}),
        },
      });

      // The join is a set: rewrite it wholesale so a credential dropped on the
      // source stops being injected here.
      const configRow = await prisma.sandboxConfig.findUnique({
        where: { projectId: p.id },
        select: { id: true },
      });
      if (configRow) {
        await prisma.sandboxConfigLlmCredential.deleteMany({
          where: { configId: configRow.id },
        });
        for (const credentialId of c.llmCredentialIds) {
          const credExists = await prisma.cloudCredential.findUnique({
            where: { id: credentialId },
            select: { id: true },
          });
          if (!credExists) continue;
          await prisma.sandboxConfigLlmCredential.create({
            data: { configId: configRow.id, credentialId },
          });
        }
      }
    }
  }

  // ---- roadmap -----------------------------------------------------------
  // DevPhases before Features: the feature FK points at them.
  for (const d of p.devPhases) {
    const row = await prisma.devPhase.findUnique({
      where: { id: d.id },
      select: { id: true },
    });
    if (row) counts.devPhases.update++;
    else counts.devPhases.create++;
    if (!write) continue;
    await prisma.devPhase.upsert({
      where: { id: d.id },
      create: {
        id: d.id,
        projectId: p.id,
        name: d.name,
        goal: d.goal,
        order: d.order,
        status: d.status,
        sourceSectionKeys: json(d.sourceSectionKeys),
      },
      update: {
        name: d.name,
        goal: d.goal,
        order: d.order,
        status: d.status,
        sourceSectionKeys: json(d.sourceSectionKeys),
      },
    });
  }

  for (const ph of p.phases) {
    const row = await prisma.phase.findUnique({
      where: { id: ph.id },
      select: { id: true },
    });
    if (row) counts.phases.update++;
    else counts.phases.create++;
    if (!write) continue;
    await prisma.phase.upsert({
      // (projectId, key) is @@unique — keying on it avoids a collision with a
      // destination-side phase of the same key under another id.
      where: { projectId_key: { projectId: p.id, key: ph.key } },
      create: {
        id: ph.id,
        projectId: p.id,
        key: ph.key,
        order: ph.order,
        status: ph.status,
        title: ph.title,
        summary: ph.summary,
      },
      update: {
        order: ph.order,
        status: ph.status,
        title: ph.title,
        summary: ph.summary,
      },
    });
  }

  for (const f of p.features) {
    const row = await prisma.feature.findUnique({
      where: { id: f.id },
      select: { id: true },
    });
    if (row) counts.features.update++;
    else counts.features.create++;
    if (!write) continue;
    await prisma.feature.upsert({
      where: { id: f.id },
      create: {
        id: f.id,
        projectId: p.id,
        devPhaseId: f.devPhaseId,
        title: f.title,
        description: f.description,
        status: f.status,
        priority: f.priority,
        aiRefinement: f.aiRefinement,
        sourceSectionKeys: json(f.sourceSectionKeys),
        attachments: json(f.attachments),
        order: f.order,
      },
      update: {
        devPhaseId: f.devPhaseId,
        title: f.title,
        description: f.description,
        status: f.status,
        priority: f.priority,
        aiRefinement: f.aiRefinement,
        sourceSectionKeys: json(f.sourceSectionKeys),
        attachments: json(f.attachments),
        order: f.order,
      },
    });
  }

  // ---- definition document ----------------------------------------------
  if (p.document) {
    const doc = p.document;
    if (write) {
      await prisma.projectDocument.upsert({
        // projectId is @unique.
        where: { projectId: p.id },
        create: {
          id: doc.id,
          projectId: p.id,
          version: doc.version,
          status: doc.status,
        },
        update: { version: doc.version, status: doc.status },
      });
    }
    const documentRow = write
      ? await prisma.projectDocument.findUnique({
          where: { projectId: p.id },
          select: { id: true },
        })
      : null;

    for (const s of doc.sections) {
      const row = await prisma.projectDocumentSection.findUnique({
        where: { id: s.id },
        select: { id: true },
      });
      if (row) counts.documentSections.update++;
      else counts.documentSections.create++;
      if (!write || !documentRow) continue;
      await prisma.projectDocumentSection.upsert({
        // (documentId, key) is @@unique.
        where: { documentId_key: { documentId: documentRow.id, key: s.key } },
        create: {
          id: s.id,
          documentId: documentRow.id,
          phaseKey: s.phaseKey,
          key: s.key,
          title: s.title,
          content: s.content,
          ownerRole: s.ownerRole,
          order: s.order,
          status: s.status,
        },
        update: {
          phaseKey: s.phaseKey,
          title: s.title,
          content: s.content,
          ownerRole: s.ownerRole,
          order: s.order,
          status: s.status,
        },
      });
    }
  }

  // ---- brain -------------------------------------------------------------
  if (p.brain && write) {
    await prisma.projectBrain.upsert({
      where: { projectId: p.id },
      create: {
        id: p.brain.id,
        projectId: p.id,
        provider: p.brain.provider,
        model: p.brain.model,
        config: json(p.brain.config),
      },
      update: {
        provider: p.brain.provider,
        model: p.brain.model,
        config: json(p.brain.config),
      },
    });
  }

  // ---- schedules ---------------------------------------------------------
  // Always imported disabled. A schedule arriving live would provision cloud
  // sandboxes and open PRs here while the source instance still does the same
  // on its own timer — duplicate agents, duplicate PRs, double spend.
  for (const s of p.schedules) {
    const row = await prisma.taskSchedule.findUnique({
      where: { id: s.id },
      select: { id: true },
    });
    if (row) counts.schedules.update++;
    else counts.schedules.create++;
    if (s.enabled) plan.schedules.importedDisabled++;
    if (!write) continue;
    const data = {
      featureId: s.featureId,
      prompt: s.prompt,
      provider: s.provider,
      ephemeral: s.ephemeral,
      cron: s.cron,
      runAt: s.runAt ? new Date(s.runAt) : null,
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      lastTaskId: null,
    };
    await prisma.taskSchedule.upsert({
      where: { id: s.id },
      create: { id: s.id, projectId: p.id, ...data },
      update: data,
    });
  }

  // ---- catalog joins -----------------------------------------------------
  if (write) {
    const skillId = (id: string) => ctx.skillIdMap.get(id) ?? id;
    const agentId = (id: string) => ctx.agentIdMap.get(id) ?? id;

    for (const id of p.skillIds) {
      const target = skillId(id);
      const skillExists = await prisma.skill.findUnique({
        where: { id: target },
        select: { id: true },
      });
      if (!skillExists) continue;
      await prisma.projectSkill.upsert({
        where: { projectId_skillId: { projectId: p.id, skillId: target } },
        create: { projectId: p.id, skillId: target },
        update: {},
      });
    }
    for (const id of p.agentIds) {
      const target = agentId(id);
      const agentExists = await prisma.agent.findUnique({
        where: { id: target },
        select: { id: true },
      });
      if (!agentExists) continue;
      await prisma.projectAgent.upsert({
        where: { projectId_agentId: { projectId: p.id, agentId: target } },
        create: { projectId: p.id, agentId: target },
        update: {},
      });
    }
    for (const join of p.agentSkills) {
      const a = agentId(join.agentId);
      const s = skillId(join.skillId);
      const [agentExists, skillExists] = await Promise.all([
        prisma.agent.findUnique({ where: { id: a }, select: { id: true } }),
        prisma.skill.findUnique({ where: { id: s }, select: { id: true } }),
      ]);
      if (!agentExists || !skillExists) continue;
      await prisma.agentSkill.upsert({
        where: {
          agentId_skillId_projectId: {
            agentId: a,
            skillId: s,
            projectId: p.id,
          },
        },
        create: { agentId: a, skillId: s, projectId: p.id },
        update: {},
      });
    }
  }

  // ---- conversations -----------------------------------------------------
  for (const c of p.conversations) {
    const row = await prisma.conversation.findUnique({
      where: { id: c.id },
      select: { id: true },
    });
    if (row) counts.conversations.update++;
    else counts.conversations.create++;
    if (!write) continue;
    await prisma.conversation.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        projectId: p.id,
        featureId: c.featureId,
        sessionId: c.sessionId,
        name: c.name,
        status: c.status,
        agentId: c.agentId ? (ctx.agentIdMap.get(c.agentId) ?? c.agentId) : null,
        model: c.model,
        permissionMode: c.permissionMode,
        systemPrompt: c.systemPrompt,
        totalCostUsd: c.totalCostUsd,
      },
      update: { name: c.name, status: c.status, totalCostUsd: c.totalCostUsd },
    });
    for (const m of c.messages) {
      await prisma.message.upsert({
        where: { id: m.id },
        create: {
          id: m.id,
          conversationId: c.id,
          role: m.role,
          content: m.content,
          messageType: m.messageType,
          claudeMessageId: m.claudeMessageId,
          costUsd: m.costUsd,
          agentRole: m.agentRole,
          createdAt: new Date(m.createdAt),
        },
        update: {},
      });
    }
  }

  // ---- replace: delete what the file does not carry ----------------------
  // Scoped to this project only. Layer 3 is never touched, and catalogs are
  // left alone because they are shared with projects outside the import.
  if (mode === "replace") {
    const keep = {
      repositories: p.repositories.map((r) => r.id),
      stackNodes: p.stack.nodes.map((n) => n.id),
      stackEdges: p.stack.edges.map((e) => e.id),
      envVars: p.envVars.map((v) => v.id),
      features: p.features.map((f) => f.id),
      devPhases: p.devPhases.map((d) => d.id),
      schedules: p.schedules.map((s) => s.id),
    };

    const staleCounts = await Promise.all([
      prisma.repository.count({
        where: { projectId: p.id, id: { notIn: keep.repositories } },
      }),
      prisma.stackNode.count({
        where: { projectId: p.id, id: { notIn: keep.stackNodes } },
      }),
      prisma.stackEdge.count({
        where: { projectId: p.id, id: { notIn: keep.stackEdges } },
      }),
      prisma.projectEnvVar.count({
        where: { projectId: p.id, id: { notIn: keep.envVars } },
      }),
      prisma.feature.count({
        where: { projectId: p.id, id: { notIn: keep.features } },
      }),
      prisma.devPhase.count({
        where: { projectId: p.id, id: { notIn: keep.devPhases } },
      }),
      prisma.taskSchedule.count({
        where: { projectId: p.id, id: { notIn: keep.schedules } },
      }),
    ]);
    counts.repositories.delete = staleCounts[0];
    counts.stackNodes.delete = staleCounts[1];
    counts.stackEdges.delete = staleCounts[2];
    counts.envVars.delete = staleCounts[3];
    counts.features.delete = staleCounts[4];
    counts.devPhases.delete = staleCounts[5];
    counts.schedules.delete = staleCounts[6];

    if (write) {
      // Edges before nodes: an edge FKs both ends.
      await prisma.stackEdge.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.stackEdges } },
      });
      await prisma.stackNode.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.stackNodes } },
      });
      await prisma.projectEnvVar.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.envVars } },
      });
      await prisma.taskSchedule.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.schedules } },
      });
      await prisma.feature.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.features } },
      });
      await prisma.devPhase.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.devPhases } },
      });
      await prisma.repository.deleteMany({
        where: { projectId: p.id, id: { notIn: keep.repositories } },
      });
    }
  }

  return {
    id: p.id,
    name: p.name,
    action: existing ? "update" : "create",
    counts,
    paths,
  };
}
