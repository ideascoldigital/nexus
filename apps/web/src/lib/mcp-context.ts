import { prisma } from "@nexux/db";
import type {
  ActivitySummary,
  CreateProjectInput,
  CreateTaskInput,
  ProjectDetail,
  DockerEndpointSummary,
  LaunchSandboxInput,
  NexuxContext,
  PowerAction,
  ProjectSummary,
  SandboxSummary,
  SeedResetSummary,
  StackValidationSummary,
  TaskSummary,
} from "@nexux/mcp";

import { createTask } from "@/lib/task-manager";
import {
  getSandboxReadiness,
  launchSandbox,
  pauseSandbox,
  reconcileLocalSandboxStatuses,
  resumeSandbox,
} from "@/lib/sandbox-manager";
import { describeStack, validateProject } from "@/services/stack-validation";
import { repairProjectStack } from "@/services/stack-repair";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";
import { createProject, BootstrapError, ProjectCreateError } from "@/lib/project-create";
import { editProjectFile, listProjectDir, readProjectFileLines, writeProjectFile } from "@/lib/project-files";
import { scanDirectory } from "@/lib/repo-scan";
import { BOOTSTRAP_TEMPLATES } from "@/lib/bootstrap/templates";
import { cloneRepository } from "@/lib/repo-clone";
import { detectAndCache } from "@/lib/stack/detect-cache";
import { getConfig } from "@nexux/config";
import { expandHome } from "@nexux/storage";
import path from "node:path";

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

/** Where new projects go by default — the wizard's own suggestion (projects/defaults route). */
const defaultParentPath = () =>
  process.env.NEXUX_ROLE === "host" ? getConfig().workspaceRoot : "~/Projects";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";

const PROJECT_DETAIL_SELECT = {
  id: true,
  name: true,
  description: true,
  workspacePath: true,
  bootstrapType: true,
  createdAt: true,
  repositories: {
    orderBy: [{ isMain: "desc" as const }, { createdAt: "asc" as const }],
    select: { id: true, name: true, repoUrl: true, localPath: true, isMain: true, cloneStatus: true },
  },
};

function toProjectDetail(p: {
  id: string;
  name: string;
  description: string | null;
  workspacePath: string | null;
  bootstrapType: string | null;
  createdAt: Date;
  repositories: ProjectDetail["repositories"];
}): ProjectDetail {
  return { ...p, createdAt: p.createdAt.toISOString() };
}

/**
 * The host half of the MCP control surface (spec 21): real implementations of
 * everything `@nexux/mcp` is allowed to call. The package holds what the tools
 * are; this holds what they actually reach.
 *
 * Every method here is deliberately thin. `createTask`, `launchSandbox` and
 * the power pair already enforce their own rules — sandbox reachable, not
 * already busy, follow-ups on the same branch — and they are the same
 * functions the board, Telegram and the tasks API go through. Re-checking any
 * of that here would create a fifth place for those rules to drift.
 */

/**
 * MCP requests carry a token, not a cookie, so there is no active workspace to
 * read: `getActiveWorkspaceId()` reads `next/headers` and would throw. Tokens
 * are install-wide (spec 21 leaves per-workspace tokens as an open question),
 * so the surface answers for the default workspace — the one everything
 * created before workspaces lives in, and the one a single-user install has.
 */

const TASK_FIELDS = {
  id: true,
  sandboxId: true,
  featureId: true,
  status: true,
  phase: true,
  prompt: true,
  branch: true,
  prUrl: true,
  createdAt: true,
  finishedAt: true,
  sandbox: { select: { projectId: true } },
} as const;

type TaskRow = {
  id: string;
  sandboxId: string;
  featureId: string | null;
  status: string;
  phase: string | null;
  prompt: string;
  branch: string | null;
  prUrl: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  sandbox: { projectId: string };
};

function toTask(row: TaskRow): TaskSummary {
  return {
    id: row.id,
    projectId: row.sandbox.projectId,
    sandboxId: row.sandboxId,
    featureId: row.featureId,
    status: row.status,
    // The same derivation the ⌘J switcher uses — "needs_input" is a phase, not
    // a column, and a client must not have to know that.
    needsInput: row.phase === "needs_input",
    prompt: row.prompt,
    branch: row.branch,
    prUrl: row.prUrl,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

type SandboxRow = {
  id: string;
  projectId: string;
  name: string;
  status: string;
  provider: string;
  region: string;
  dockerEndpointId: string | null;
  dockerHost: string | null;
  previewUrl: string | null;
  createdAt: Date;
};

/**
 * Where a sandbox runs, in words. A local sandbox on another machine's Docker
 * records that endpoint's name as its region at launch — kept on the row, so
 * it still reads right after the endpoint is renamed or removed.
 */
export function sandboxRunsOn(row: Pick<SandboxRow, "provider" | "region" | "dockerHost">): string {
  if (row.provider === "local") return row.dockerHost ? row.region : "this machine";
  return `${row.provider} ${row.region}`;
}

function toSandbox(row: SandboxRow): SandboxSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    provider: row.provider,
    runsOn: sandboxRunsOn(row),
    dockerEndpointId: row.dockerEndpointId,
    previewUrl: row.previewUrl,
    createdAt: row.createdAt.toISOString(),
  };
}

const SANDBOX_FIELDS = {
  id: true,
  projectId: true,
  name: true,
  status: true,
  provider: true,
  region: true,
  dockerEndpointId: true,
  dockerHost: true,
  previewUrl: true,
  createdAt: true,
} as const;

/** How many finished runs to carry — the activity route's own limit. */
const RECENT_LIMIT = 12;

export type McpContextOptions = {
  /** The workspace the caller acts in; API tokens are install-wide and get the default one. */
  workspaceId?: string;
  /** Told about each project created through this context (the Nexus chat follows it). */
  onProjectCreated?: (projectId: string) => void;
  /**
   * Asked before anything that costs money (a cloud sandbox). Returns null when
   * the user already approved exactly this, else the id of a pending approval
   * the chat shows as a confirm card. Without it (API tokens), no gate: the
   * token's scope is the consent.
   */
  confirm?: (action: { key: string; summary: string }) => string | null;
  /** Told about each sandbox launched through this context (the chat follows it). */
  onSandboxLaunched?: (sandboxId: string) => void;
};

/** Thrown when an action waits for the user's tap on a confirm card. */
export class NeedsConfirmation extends Error {
  constructor(readonly actionId: string, readonly summary: string) {
    super(
      `Needs the user's confirmation (it costs money): ${summary}. Do not retry yet. End your reply with a confirm card ` +
        `\`\`\`confirm {"actionId": "${actionId}", "title": "<short title>", "detail": "<what it creates and that it costs money until destroyed>"}\`\`\` ` +
        "and wait. When the user confirms, call the same tool again with the same arguments.",
    );
    this.name = "NeedsConfirmation";
  }
}

export function createMcpContext(opts: McpContextOptions = {}): NexuxContext {
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  /**
   * Refuses a project outside this workspace, the same way every other method
   * here scopes its query. A read tool that skipped it would answer questions
   * about a project the token cannot otherwise see.
   */
  const assertProject = async (projectId: string) => {
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true },
    });
    if (!project) throw new Error("Project not found");
  };

  const projectDetail = async (projectId: string): Promise<ProjectDetail | null> => {
    const p = await prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: PROJECT_DETAIL_SELECT,
    });
    return p ? toProjectDetail(p) : null;
  };

  /** The repository's folder, by name or id, within this workspace's project. */
  const repoRoot = async (projectId: string, repository: string): Promise<string> => {
    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { repositories: { select: { id: true, name: true, localPath: true } } },
    });
    if (!project) throw new Error("Project not found");
    const repo = project.repositories.find((r) => r.id === repository || r.name === repository);
    if (!repo) throw new Error(`No repository "${repository}" in this project`);
    if (!repo.localPath) throw new Error(`"${repo.name}" has no folder on this machine yet`);
    return expandHome(repo.localPath);
  };

  return {
    getProject: projectDetail,

    async listProjectFiles(projectId: string, repository: string, dir: string) {
      return listProjectDir(await repoRoot(projectId, repository), dir);
    },

    async readProjectFile(projectId: string, repository: string, file: string, offset?: number, limit?: number) {
      return readProjectFileLines(await repoRoot(projectId, repository), file, offset, limit);
    },

    async writeProjectFile(projectId: string, repository: string, file: string, content: string) {
      return writeProjectFile(await repoRoot(projectId, repository), file, content);
    },

    async editProjectFile(projectId: string, repository: string, file: string, oldText: string, newText: string, all?: boolean) {
      return editProjectFile(await repoRoot(projectId, repository), file, oldText, newText, all);
    },

    async scanDirectory(directory: string) {
      return scanDirectory(directory);
    },

    async listBootstrapTypes() {
      return {
        types: BOOTSTRAP_TEMPLATES.map((t) => ({ key: t.key, name: t.name, tagline: t.tagline })),
        // Same default the wizard offers (projects/defaults route).
        defaultParentPath: defaultParentPath(),
      };
    },

    async listGitCredentials() {
      // Name and provider only: the token stays in Nexus, and a clone looks
      // it up by id on its own side.
      return prisma.cloudCredential.findMany({
        where: { workspaceId, provider: { in: GIT_PROVIDERS } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, provider: true },
      });
    },

    async createProject(input: CreateProjectInput): Promise<ProjectDetail> {
      // A Git URL with nowhere to live cannot be cloned: give it a folder
      // under the project's (the wizard asks; a conversation should not have to).
      const base = input.workspacePath ?? path.join(defaultParentPath(), slugify(input.name));
      const repositories = input.repositories?.map((r) =>
        r.localPath ? r : { ...r, localPath: path.join(base, slugify(r.name)) },
      );
      const withFolder = repositories?.some((r, i) => r !== input.repositories![i])
        ? { ...input, workspacePath: input.workspacePath ?? base, repositories }
        : input;
      try {
        const created = await createProject(
          { ...withFolder, repositories: withFolder.repositories?.map((r) => ({ ...r, localPath: r.localPath && expandHome(r.localPath) })) },
          workspaceId,
        );
        opts.onProjectCreated?.(created.id);
        return (await projectDetail(created.id))!;
      } catch (err) {
        // The caller's mistake (a bad folder, an unknown credential): said as
        // such, not as a server failure.
        if (err instanceof BootstrapError || err instanceof ProjectCreateError) throw new Error(err.message);
        throw err;
      }
    },

    async cloneRepositories(projectId: string): Promise<ProjectDetail> {
      await assertProject(projectId);
      const repos = await prisma.repository.findMany({
        where: { projectId, cloneStatus: { in: ["pending", "error"] } },
        orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
        select: { id: true },
      });
      // A clone can take minutes; a tool call must not. Each one marks its
      // row cloning → ready | error, which nexux_get_project reports.
      if (repos.length) {
        await prisma.repository.updateMany({
          where: { id: { in: repos.map((r) => r.id) } },
          data: { cloneStatus: "cloning" },
        });
        void (async () => {
          for (const r of repos) {
            await cloneRepository(r.id).catch((err) =>
              console.warn("[mcp] clone failed:", err instanceof Error ? err.message : err),
            );
          }
        })();
      }
      return (await projectDetail(projectId))!;
    },

    async detectStack(projectId: string) {
      await assertProject(projectId);
      const repos = await prisma.repository.findMany({
        where: { projectId },
        orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
        select: { id: true, name: true, localPath: true, cloneStatus: true },
      });
      const out = [];
      for (const repo of repos) {
        if (!repo.localPath || repo.cloneStatus !== "ready") {
          out.push({ repository: repo.name, skipped: `not checked out (${repo.cloneStatus})` });
          continue;
        }
        try {
          const d = await detectAndCache({ id: repo.id, localPath: repo.localPath });
          // What a conversation can use. Example env *values* stay out: a
          // committed example file sometimes holds a real key.
          out.push({
            repository: repo.name,
            packageManager: d.packageManager,
            commands: d.suggestedCommands,
            ports: d.suggestedPorts,
            dockerfile: d.hasDockerfile ? (d.dockerfilePath ?? true) : false,
            compose: d.hasCompose ? (d.composePath ?? true) : false,
            makeTargets: d.makeTargets ?? [],
            scripts: d.scripts,
            envKeys: d.envExampleKeys,
            notes: d.notes ?? [],
          });
        } catch (err) {
          out.push({ repository: repo.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { repositories: out };
    },

    async listProjects(): Promise<ProjectSummary[]> {
      const projects = await prisma.project.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, createdAt: true },
      });
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt.toISOString(),
      }));
    },

    async getActivity(): Promise<ActivitySummary> {
      const inWorkspace = { sandbox: { project: { workspaceId } } };

      const [active, recent, idle] = await Promise.all([
        // Oldest first: something that has been waiting on an answer is the
        // thing to act on, and recency would bury it under whatever started
        // last. Same ordering as the switcher, for the same reason.
        prisma.sandboxTask.findMany({
          where: { ...inWorkspace, status: { in: ["running", "queued"] } },
          orderBy: { updatedAt: "asc" },
          select: TASK_FIELDS,
        }),
        prisma.sandboxTask.findMany({
          where: { ...inWorkspace, status: { in: ["completed", "error"] } },
          orderBy: { finishedAt: "desc" },
          take: RECENT_LIMIT,
          select: TASK_FIELDS,
        }),
        prisma.sandbox.findMany({
          where: {
            project: { workspaceId },
            archived: false,
            status: "running",
            tasks: { none: { status: { in: ["running", "queued"] } } },
          },
          orderBy: { createdAt: "desc" },
          select: SANDBOX_FIELDS,
        }),
      ]);

      const tasks = active.map(toTask);
      return {
        // A blocked run is not counted as running: it holds a slot and looks
        // busy while nothing at all is happening in it.
        blocked: tasks.filter((t) => t.needsInput),
        running: tasks.filter((t) => !t.needsInput && t.status === "running"),
        queued: tasks.filter((t) => !t.needsInput && t.status === "queued"),
        recentlyFinished: recent.map(toTask),
        idleSandboxes: idle.map(toSandbox),
      };
    },

    async listSandboxes(projectId: string): Promise<SandboxSummary[]> {
      // A container can die without the status column being written (OOM,
      // Docker restart), so reconcile first — otherwise a dead box is reported
      // as running and a task is dispatched at it.
      await reconcileLocalSandboxStatuses(projectId).catch(() => undefined);

      const sandboxes = await prisma.sandbox.findMany({
        where: { projectId, project: { workspaceId }, archived: false },
        orderBy: { createdAt: "desc" },
        select: SANDBOX_FIELDS,
      });
      return sandboxes.map(toSandbox);
    },

    async listDockerEndpoints(): Promise<DockerEndpointSummary[]> {
      const endpoints = await prisma.dockerEndpoint.findMany({
        orderBy: { name: "asc" },
      });
      return endpoints.map((e) => {
        const check = e.sandboxCheck as { status?: string } | null;
        return {
          id: e.id,
          name: e.name,
          host: e.host,
          arch: e.arch,
          memTotalMb: e.memTotalMb,
          sandboxReady: check?.status ? check.status !== "fail" : null,
        };
      });
    },

    async sandboxOptions(projectId: string) {
      await assertProject(projectId);
      const [readiness, endpoints, config, sandboxes] = await Promise.all([
        getSandboxReadiness(),
        this.listDockerEndpoints(),
        prisma.sandboxConfig.findUnique({
          where: { projectId },
          select: { provider: true, region: true, size: true, dockerEndpointId: true },
        }),
        this.listSandboxes(projectId),
      ]);
      return {
        local: { available: readiness.dockerInstalled },
        dockerEndpoints: endpoints,
        cloud: {
          civo: readiness.hasCivoToken,
          aws: readiness.hasAwsCredentials,
          terraformInstalled: readiness.terraformInstalled,
        },
        saved: config,
        sandboxes,
      };
    },

    async getTask(taskId: string): Promise<TaskSummary | null> {
      const task = await prisma.sandboxTask.findFirst({
        where: { id: taskId, sandbox: { project: { workspaceId } } },
        select: TASK_FIELDS,
      });
      return task ? toTask(task) : null;
    },

    async getTaskLogs(taskId: string, tailLines = 200): Promise<string | null> {
      const task = await prisma.sandboxTask.findFirst({
        where: { id: taskId, sandbox: { project: { workspaceId } } },
        select: { log: true },
      });
      if (!task) return null;
      const lines = task.log.split("\n");
      return lines.slice(-tailLines).join("\n");
    },

    async createTask(input: CreateTaskInput): Promise<TaskSummary> {
      const task = await createTask({
        projectId: input.projectId,
        sandboxId: input.sandboxId,
        prompt: input.prompt,
        featureId: input.featureId ?? null,
        followUpOf: input.followUpOf ?? null,
      });
      // createTask returns the row without the sandbox relation toTask reads.
      return toTask({ ...task, sandbox: { projectId: input.projectId } });
    },

    async launchSandbox(input: LaunchSandboxInput): Promise<SandboxSummary> {
      const project = await prisma.project.findFirst({
        where: { id: input.projectId, workspaceId },
        select: { id: true, name: true, sandboxConfig: { select: { provider: true, region: true, size: true } } },
      });
      if (!project) throw new Error("Project not found");
      // A cloud machine costs money: the chat asks first (spec 39).
      const effective = input.provider ?? (project.sandboxConfig?.provider === "aws" || project.sandboxConfig?.provider === "local" ? project.sandboxConfig.provider : "civo");
      if (opts.confirm && effective !== "local") {
        const where = `${effective.toUpperCase()} ${project.sandboxConfig?.region ?? (effective === "aws" ? "us-east-1" : "NYC1")}, ${project.sandboxConfig?.size ?? "default size"}`;
        const summary = `launch a ${effective} sandbox for "${project.name}" (${where})`;
        const pending = opts.confirm({ key: JSON.stringify(["launch", input.projectId, effective, input.name ?? null]), summary });
        if (pending) throw new NeedsConfirmation(pending, summary);
      }

      // Which providers an install accepts depends on its credentials, so the
      // value is validated here rather than in the package's tool definition.
      if (
        input.provider &&
        !["civo", "aws", "local"].includes(input.provider)
      ) {
        throw new Error("provider must be one of: civo, aws, local");
      }

      const dockerEndpointId = await resolveEndpointArg(input.dockerEndpoint);
      const sandbox = await launchSandbox(
        input.projectId,
        input.provider as "civo" | "aws" | "local" | undefined,
        input.name,
        dockerEndpointId,
      );
      opts.onSandboxLaunched?.(sandbox.id);
      return toSandbox(sandbox);
    },

    async validateStack(projectId: string): Promise<StackValidationSummary> {
      await assertProject(projectId);
      const result = await validateProject(projectId);
      return {
        ok: result.ok,
        findings: result.findings,
        // Trimmed to what a caller can act on: the whole step list is mostly
        // green apt installs, and a tool answer that has to be paged through
        // is one nobody reads to the end of.
        observed: result.observed
          ? {
              sandboxName: result.observed.sandboxName,
              provisionedAt: result.observed.provisionedAt,
              booted: result.observed.booted,
              failed: result.observed.failed.map((s) => ({
                step: s.step,
                exitCode: s.exitCode,
                durationMs: s.durationMs,
                ...(s.tail ? { tail: s.tail } : {}),
              })),
              ...(result.observed.unavailable
                ? { unavailable: result.observed.unavailable }
                : {}),
            }
          : null,
      };
    },

    async describeStack(projectId: string): Promise<unknown> {
      await assertProject(projectId);
      return describeStack(projectId);
    },

    async repairStack(projectId: string, maxRounds?: number): Promise<unknown> {
      await assertProject(projectId);
      return repairProjectStack(projectId, { maxRounds });
    },

    async resetSandboxData(sandboxId: string, service?: string): Promise<SeedResetSummary> {
      const owned = await prisma.sandbox.findFirst({
        where: { id: sandboxId, project: { workspaceId } },
        select: { id: true },
      });
      if (!owned) throw new Error("Sandbox not found");
      const { resetSandboxData } = await import("@/lib/seed/reset");
      const res = await resetSandboxData(sandboxId, { service });
      // The log stays out: it is long, and the per-service messages say what a
      // caller can act on.
      return { ok: res.ok, services: res.services, setup: res.setup };
    },

    async powerSandbox(
      sandboxId: string,
      action: PowerAction,
    ): Promise<SandboxSummary> {
      const owned = await prisma.sandbox.findFirst({
        where: { id: sandboxId, project: { workspaceId } },
        select: { id: true },
      });
      if (!owned) throw new Error("Sandbox not found");

      const sandbox =
        action === "pause"
          ? await pauseSandbox(sandboxId)
          : await resumeSandbox(sandboxId);
      return toSandbox(sandbox);
    },
  };
}

/**
 * `dockerEndpoint` as a caller gives it — an id, a name, or "this-machine" —
 * as launchSandbox takes it: undefined (the project's saved choice), null
 * (this machine) or an id. A name is what a person or an agent remembers; an
 * unknown one is refused rather than quietly launched somewhere else.
 */
export async function resolveEndpointArg(
  value: string | undefined,
): Promise<string | null | undefined> {
  const v = value?.trim();
  if (!v) return undefined;
  if (v === "this-machine") return null;
  const endpoint = await prisma.dockerEndpoint.findFirst({
    where: { OR: [{ id: v }, { name: v }] },
    select: { id: true },
  });
  if (!endpoint) {
    throw new Error(
      `No Docker endpoint "${v}" — see nexux_list_docker_endpoints, or pass "this-machine".`,
    );
  }
  return endpoint.id;
}
