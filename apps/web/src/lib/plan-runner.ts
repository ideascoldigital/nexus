// Read-only feature planning on the dev sandbox. A Claude plan-mode run
// cannot edit files or run mutating commands, so it shares the sandbox with
// live work — no sandbox lock, no dev queue, and never the chat's continuous
// session. Its whole deliverable is the reply text, saved as a Plan row that
// buildFeaturePrompt later hands to the implementing run.

import { prisma, type Feature, type Sandbox } from "@nexux/db";
import { runClaudeTask } from "@nexux/sandbox";
import {
  buildPlanFollowUpPrompt,
  buildPlanPrompt,
  sandboxReachable,
  sandboxTarget,
} from "@/lib/agent-core";
import {
  buildSearchContext,
  createLogWriter,
  resolveWorkDir,
} from "@/lib/task-manager";
import { notifyTaskFinished } from "@/lib/notify";

const globalForPlans = globalThis as unknown as {
  nexuxPlanRuns: Set<string> | undefined;
};
// One planning run per sandbox at a time — a resource cap (two exploring
// Claudes plus live work on one VM), not a correctness lock: plan mode
// cannot touch the working tree.
const activePlans = (globalForPlans.nexuxPlanRuns ??= new Set<string>());

const PLAN_TIMEOUT_MS = 20 * 60 * 1000;

type PlanFeature = Feature & {
  devPhase: { name: string; goal: string | null } | null;
};

/**
 * Start a plan-mode run for a feature on the project's dev sandbox. Returns
 * the running task (it also shows up in the feature's Runs list). Throws when
 * there is no reachable dev sandbox or a plan is already being generated.
 *
 * With `followUp`, the run revises the existing plan instead of starting
 * over: it resumes the previous planning session when it still exists, and
 * otherwise carries the previous plan text into a fresh session.
 */
export async function enqueuePlanRun(
  projectId: string,
  featureId: string,
  opts?: { followUp?: string },
) {
  const feature = (await prisma.feature.findFirst({
    where: { id: featureId, projectId },
    include: { devPhase: { select: { name: true, goal: true } } },
  })) as PlanFeature | null;
  if (!feature) throw new Error("Feature not found");

  const sandbox = await prisma.sandbox.findFirst({
    where: { projectId, dedicated: true, status: "running", archived: false },
    orderBy: { createdAt: "desc" },
  });
  if (!sandbox || !sandboxReachable(sandbox)) {
    throw new Error(
      "No running dev sandbox — planning needs one to read the real code",
    );
  }
  if (activePlans.has(sandbox.id)) {
    throw new Error(
      "A plan is already being generated on this sandbox — wait for it to finish",
    );
  }
  const inFlight = await prisma.sandboxTask.findFirst({
    where: { featureId, kind: "plan", status: { in: ["queued", "running"] } },
    select: { id: true },
  });
  if (inFlight) throw new Error("This feature already has a plan run in flight");

  const followUp = opts?.followUp?.trim() || null;
  // Follow-up context: the last completed plan run's session (to resume) and
  // the newest plan text (the cold fallback when that session is gone).
  const [prevRun, prevPlan] = followUp
    ? await Promise.all([
        prisma.sandboxTask.findFirst({
          where: {
            featureId,
            kind: "plan",
            status: "completed",
            sessionId: { not: null },
          },
          orderBy: { createdAt: "desc" },
          select: { sessionId: true },
        }),
        prisma.plan.findFirst({
          where: { featureId },
          orderBy: { updatedAt: "desc" },
          select: { content: true },
        }),
      ])
    : [null, null];

  const workDir = await resolveWorkDir(projectId);
  const task = await prisma.sandboxTask.create({
    data: {
      sandboxId: sandbox.id,
      featureId,
      kind: "plan",
      prompt: followUp
        ? `Plan follow-up: ${followUp.slice(0, 200)}`
        : `Plan: ${feature.title}`,
      workDir,
      status: "running",
      phase: "agent",
    },
  });

  activePlans.add(sandbox.id);
  void runPlanTask(task.id, sandbox, workDir, feature, {
    followUp,
    resumeSessionId: prevRun?.sessionId ?? null,
    previousPlan: prevPlan?.content ?? null,
  })
    .catch((err) => console.error("[nexux] plan run crashed:", err))
    .finally(() => activePlans.delete(sandbox.id));
  return task;
}

async function runPlanTask(
  taskId: string,
  sandbox: Sandbox,
  workDir: string,
  feature: PlanFeature,
  followUpCtx: {
    followUp: string | null;
    resumeSessionId: string | null;
    previousPlan: string | null;
  } = { followUp: null, resumeSessionId: null, previousPlan: null },
): Promise<void> {
  const log = createLogWriter(taskId);

  const fail = async (message: string) => {
    log.append(`[nexux] ERROR: ${message}`);
    await prisma.sandboxTask
      .update({
        where: { id: taskId },
        data: { status: "error", error: message, finishedAt: new Date() },
      })
      .catch(() => undefined);
    void notifyTaskFinished(taskId).catch(() => undefined);
  };

  try {
    const cfg = await prisma.sandboxConfig.findUnique({
      where: { projectId: sandbox.projectId },
    });
    // A resumed follow-up already carries the exploration in its session;
    // only fresh plans get the semantic index as a starting point.
    const searchContext = followUpCtx.followUp
      ? null
      : await buildSearchContext(
          sandbox.projectId,
          `${feature.title}\n${feature.description ?? ""}`,
        );
    const makePrompt = (resumed: boolean) =>
      followUpCtx.followUp
        ? buildPlanFollowUpPrompt({
            followUp: followUpCtx.followUp,
            resumed,
            previousPlan: followUpCtx.previousPlan,
            workDir,
          })
        : buildPlanPrompt({ feature, workDir, searchContext });

    // Always Claude, whatever the project brain: plan mode is a Claude Code
    // capability, and OpenCode has no read-only equivalent to substitute.
    log.append(
      `[nexux] plan mode → Claude on ${sandbox.name} (read-only, shares the sandbox)${
        followUpCtx.followUp
          ? followUpCtx.resumeSessionId
            ? " — resuming the planning session"
            : " — previous session gone, revising from the saved plan"
          : ""
      }`,
    );
    // A paused/upgraded sandbox can lose the stored session; the CLI then
    // dies with "No conversation found with session ID" — retry cold once.
    let staleSession = false;
    const onLog = (chunk: string) => {
      if (chunk.includes("No conversation found with session ID")) {
        staleSession = true;
      }
      log.sink(chunk);
    };
    const runOpts = {
      ...sandboxTarget(sandbox, workDir),
      onLog,
      timeoutMs: PLAN_TIMEOUT_MS,
      permissionMode: "plan" as const,
      model: cfg?.claudeModel?.trim() || undefined,
    };
    let res = await runClaudeTask(makePrompt(Boolean(followUpCtx.resumeSessionId)), {
      ...runOpts,
      resumeSessionId: followUpCtx.resumeSessionId ?? undefined,
    });
    if (!res.ok && followUpCtx.resumeSessionId && staleSession) {
      log.append(
        "[nexux] stored planning session no longer exists — starting fresh from the saved plan",
      );
      res = await runClaudeTask(makePrompt(false), runOpts);
    }

    if (!res.ok) return fail(res.error ?? "Plan run failed");
    if (!res.result?.trim()) {
      return fail("The plan run produced no plan text");
    }

    await prisma.plan.create({
      data: {
        projectId: sandbox.projectId,
        featureId: feature.id,
        title: feature.title,
        content: res.result.trim(),
        status: "draft",
      },
    });
    await prisma.sandboxTask.update({
      where: { id: taskId },
      data: {
        status: "completed",
        phase: null,
        result: res.result,
        sessionId: res.sessionId ?? null,
        costUsd: res.costUsd ?? null,
        durationMs: res.durationMs ?? null,
        finishedAt: new Date(),
      },
    });
    log.append("[nexux] plan saved as draft");
    void notifyTaskFinished(taskId).catch(() => undefined);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  } finally {
    await log.close();
  }
}

/** Latest plan text for a feature — what buildFeaturePrompt hands the implementer. */
export async function latestPlanContent(
  featureId: string,
): Promise<string | null> {
  const plan = await prisma.plan.findFirst({
    where: { featureId, status: { not: "rejected" } },
    orderBy: { updatedAt: "desc" },
    select: { content: true },
  });
  return plan?.content ?? null;
}

/**
 * Boot recovery: plan tasks left "running" by a restarted server have no
 * driver anymore — settle them so the feature can plan again.
 */
export async function recoverPlanRuns(): Promise<void> {
  await prisma.sandboxTask
    .updateMany({
      where: { kind: "plan", status: "running" },
      data: {
        status: "error",
        error: "Interrupted by a server restart — generate the plan again",
        finishedAt: new Date(),
      },
    })
    .catch(() => undefined);
}
