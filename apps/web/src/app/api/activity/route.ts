import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { getActiveWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Everything worth jumping to right now, across every project of the active
 * workspace: agent runs that are blocked on the user, runs in flight, runs that
 * just ended, and sandboxes sitting idle with no run at all.
 *
 * Its own route rather than more fields on `/api/tasks`: that one feeds the
 * dashboard's history list and is paged by recency, which is the wrong axis
 * here — a run blocked on a question an hour ago matters more than a fresh one
 * nobody is waiting on.
 */

/** How many finished runs to carry, newest first. */
const RECENT_LIMIT = 12;

export type ActivityEntry = {
  kind: "task";
  id: string;
  /** "dev" (console prompt) or "task" (feature → PR pipeline). */
  taskKind: string;
  status: string;
  phase: string | null;
  title: string;
  projectId: string;
  projectName: string;
  sandboxId: string;
  sandboxName: string;
  /** Blocked on a question from the agent. */
  needsInput: boolean;
  updatedAt: string;
  finishedAt: string | null;
};

export type ActivitySandbox = {
  kind: "sandbox";
  id: string;
  name: string;
  provider: string;
  projectId: string;
  projectName: string;
};

export async function GET(_req: NextRequest) {
  const workspaceId = await getActiveWorkspaceId();
  const inWorkspace = { sandbox: { project: { workspaceId } } };

  const [active, recent, sandboxes] = await Promise.all([
    // Blocked and in-flight runs. Ordered oldest first: something that has been
    // waiting on an answer is the thing to open, and sorting by recency would
    // bury it under whatever started last.
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
      where: { project: { workspaceId }, archived: false, status: "running" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        provider: true,
        project: { select: { id: true, name: true } },
      },
    }),
  ]);

  const busy = new Set(active.map((t) => t.sandboxId));

  return NextResponse.json({
    active: active.map(toEntry),
    recent: recent.map(toEntry),
    // Every running sandbox, not just the idle ones below: the header counts
    // machines that are up, which includes the ones busy with a run.
    sandboxesRunning: sandboxes.length,
    // Only the ones with nothing running: a sandbox already represented by an
    // active run would show up twice, saying the same thing.
    idleSandboxes: sandboxes
      .filter((s) => !busy.has(s.id))
      .map(
        (s): ActivitySandbox => ({
          kind: "sandbox",
          id: s.id,
          name: s.name,
          provider: s.provider,
          projectId: s.project.id,
          projectName: s.project.name,
        }),
      ),
  });
}

const TASK_FIELDS = {
  id: true,
  kind: true,
  status: true,
  phase: true,
  prompt: true,
  updatedAt: true,
  finishedAt: true,
  sandboxId: true,
  feature: { select: { title: true } },
  sandbox: {
    select: { name: true, project: { select: { id: true, name: true } } },
  },
} as const;

type TaskRow = {
  id: string;
  kind: string;
  status: string;
  phase: string | null;
  prompt: string;
  updatedAt: Date;
  finishedAt: Date | null;
  sandboxId: string;
  feature: { title: string } | null;
  sandbox: { name: string; project: { id: string; name: string } };
};

function toEntry(t: TaskRow): ActivityEntry {
  return {
    kind: "task",
    id: t.id,
    taskKind: t.kind,
    status: t.status,
    phase: t.phase,
    // A dev prompt has no feature, so its own text is the only label there is.
    title: t.feature?.title ?? t.prompt,
    projectId: t.sandbox.project.id,
    projectName: t.sandbox.project.name,
    sandboxId: t.sandboxId,
    sandboxName: t.sandbox.name,
    needsInput: t.phase === "needs_input",
    updatedAt: t.updatedAt.toISOString(),
    finishedAt: t.finishedAt?.toISOString() ?? null,
  };
}
