import { prisma } from "@nexux/db";
import type {
  ActivitySummary,
  CreateTaskInput,
  LaunchSandboxInput,
  NexuxContext,
  PowerAction,
  ProjectSummary,
  SandboxSummary,
  StackValidationSummary,
  TaskSummary,
} from "@nexux/mcp";

import { createTask } from "@/lib/task-manager";
import {
  launchSandbox,
  pauseSandbox,
  reconcileLocalSandboxStatuses,
  resumeSandbox,
} from "@/lib/sandbox-manager";
import { describeStack, validateProject } from "@/services/stack-validation";
import { repairProjectStack } from "@/services/stack-repair";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";

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
const workspaceId = DEFAULT_WORKSPACE_ID;

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
  previewUrl: string | null;
  createdAt: Date;
};

function toSandbox(row: SandboxRow): SandboxSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status,
    provider: row.provider,
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
  previewUrl: true,
  createdAt: true,
} as const;

/** How many finished runs to carry — the activity route's own limit. */
const RECENT_LIMIT = 12;

export function createMcpContext(): NexuxContext {
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

  return {
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
        select: { id: true },
      });
      if (!project) throw new Error("Project not found");

      // Which providers an install accepts depends on its credentials, so the
      // value is validated here rather than in the package's tool definition.
      if (
        input.provider &&
        !["civo", "aws", "local"].includes(input.provider)
      ) {
        throw new Error("provider must be one of: civo, aws, local");
      }

      const sandbox = await launchSandbox(
        input.projectId,
        input.provider as "civo" | "aws" | "local" | undefined,
        input.name,
      );
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
