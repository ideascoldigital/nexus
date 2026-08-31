// Task scheduler: fires TaskSchedule rows when they come due. Each firing is
// the full ephemeral cycle — launch a sandbox, run the task headlessly, open
// the PR, destroy the sandbox (launchAndRunTask + Sandbox.ephemeral).
//
// Local-first: a 30s in-process poll over SQLite, started from
// instrumentation.ts. Survives dev hot reloads via the globalThis guard.

import { CronExpressionParser } from "cron-parser";
import { prisma } from "@nexux/db";
import { buildFeaturePrompt, launchAndRunTask } from "./task-manager";
import { latestPlanContent } from "./plan-runner";

const POLL_MS = 30_000;

/** Next firing for a schedule, or null when it has none (one-shot done). */
export function computeNextRunAt(schedule: {
  cron: string | null;
  runAt: Date | null;
  lastRunAt: Date | null;
}): Date | null {
  if (schedule.cron) {
    try {
      return CronExpressionParser.parse(schedule.cron).next().toDate();
    } catch {
      return null; // invalid cron — never fires; surfaced by the API on save
    }
  }
  if (schedule.runAt && !schedule.lastRunAt) return schedule.runAt;
  return null;
}

export function isValidCron(cron: string): boolean {
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}

async function fireSchedule(schedule: {
  id: string;
  projectId: string;
  featureId: string | null;
  prompt: string | null;
  provider: string;
  ephemeral: boolean;
  cron: string | null;
  runAt: Date | null;
}): Promise<void> {
  let prompt = schedule.prompt?.trim() ?? "";
  if (schedule.featureId) {
    const feature = await prisma.feature.findUnique({
      where: { id: schedule.featureId },
      include: { devPhase: { select: { name: true, goal: true } } },
    });
    if (feature && !prompt) {
      prompt = buildFeaturePrompt({
        ...feature,
        planContent: await latestPlanContent(feature.id),
      });
    }
  }
  if (!prompt) {
    console.error(`[scheduler] schedule ${schedule.id} has no prompt — disabled`);
    await prisma.taskSchedule.update({
      where: { id: schedule.id },
      data: { enabled: false },
    });
    return;
  }

  console.log(`[scheduler] firing schedule ${schedule.id} (${schedule.provider})`);
  const { taskId } = await launchAndRunTask({
    projectId: schedule.projectId,
    featureId: schedule.featureId,
    prompt,
    provider:
      schedule.provider === "local" || schedule.provider === "aws"
        ? schedule.provider
        : "civo",
    ephemeral: schedule.ephemeral,
  });

  // nextRunAt/enabled were already claimed by the poller before launching.
  await prisma.taskSchedule.update({
    where: { id: schedule.id },
    data: { lastRunAt: new Date(), lastTaskId: taskId },
  });
}

// Survives dev-mode hot reloads like the prisma/telegram globals.
const globalForScheduler = globalThis as unknown as {
  nexuxTaskScheduler: { running: boolean } | undefined;
};

export function startTaskScheduler(): void {
  if (globalForScheduler.nexuxTaskScheduler?.running) return;
  const state = { running: true };
  globalForScheduler.nexuxTaskScheduler = state;

  void (async () => {
    while (state.running) {
      try {
        const due = await prisma.taskSchedule.findMany({
          where: { enabled: true, nextRunAt: { lte: new Date() } },
          take: 10,
        });
        for (const schedule of due) {
          // Claim first: push nextRunAt forward (or disable) BEFORE launching,
          // so a slow launch or a second server process can't double-fire.
          const next = computeNextRunAt({
            cron: schedule.cron,
            runAt: schedule.runAt,
            lastRunAt: new Date(),
          });
          const claimed = await prisma.taskSchedule.updateMany({
            where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
            data: { nextRunAt: next, enabled: next !== null },
          });
          if (claimed.count === 0) continue; // someone else claimed it
          await fireSchedule(schedule).catch((err) =>
            console.error(`[scheduler] schedule ${schedule.id} failed:`, err),
          );
        }
      } catch (err) {
        console.error("[scheduler] poll failed:", err);
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
}
