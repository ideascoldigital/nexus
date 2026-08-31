// Workspace pulse: what the dashboard's stat tiles read. One place computes
// it (server page and /api/metrics both call here), so the two strips can
// never disagree. Volumes are small in a local-first install — day bucketing
// happens in JS rather than fighting SQLite date functions through prisma.

import { prisma } from "@nexux/db";
import { format, startOfDay, subDays } from "date-fns";

export type WorkspaceMetrics = {
  /** USD burned today (tasks settled today). */
  spendToday: number;
  /** USD burned in the last 7 days. */
  spend7d: number;
  /** Daily spend, oldest→newest, exactly 14 entries (missing days = 0). */
  spendSeries14d: number[];
  /** Settled runs in the last 7 days. */
  runs7d: { completed: number; failed: number; successRate: number | null };
  /** Distinct PRs/MRs opened by runs in the last 7 days. */
  prs7d: number;
  /** Machines up right now — cloud ones cost money, local ones don't. */
  sandboxes: { cloud: number; local: number };
  /** Features sitting in review across the workspace. */
  featuresInReview: number;
  /** Plans waiting for a verdict (draft or pending_review). */
  plansAwaiting: number;
};

export async function getWorkspaceMetrics(
  workspaceId: string,
): Promise<WorkspaceMetrics> {
  const now = new Date();
  const since14 = startOfDay(subDays(now, 13));
  const since7 = subDays(now, 7);
  const inWorkspace = { sandbox: { project: { workspaceId } } };

  const [tasks14, cloudUp, localUp, featuresInReview, plansAwaiting] =
    await Promise.all([
      prisma.sandboxTask.findMany({
        where: { createdAt: { gte: since14 }, ...inWorkspace },
        select: {
          status: true,
          costUsd: true,
          prUrl: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      prisma.sandbox.count({
        where: {
          status: "running",
          NOT: { provider: "local" },
          project: { workspaceId },
        },
      }),
      prisma.sandbox.count({
        where: {
          status: "running",
          provider: "local",
          project: { workspaceId },
        },
      }),
      prisma.feature.count({
        where: { status: "in_review", project: { workspaceId } },
      }),
      prisma.plan.count({
        where: {
          status: { in: ["draft", "pending_review"] },
          project: { workspaceId },
        },
      }),
    ]);

  // Spend buckets by the day the run settled (cost exists only then).
  const dayKey = (d: Date) => format(d, "yyyy-MM-dd");
  const spendByDay = new Map<string, number>();
  for (const t of tasks14) {
    if (!t.costUsd) continue;
    const key = dayKey(t.finishedAt ?? t.createdAt);
    spendByDay.set(key, (spendByDay.get(key) ?? 0) + t.costUsd);
  }
  const spendSeries14d: number[] = [];
  for (let i = 13; i >= 0; i--) {
    spendSeries14d.push(spendByDay.get(dayKey(subDays(now, i))) ?? 0);
  }
  const spendToday = spendSeries14d[13] ?? 0;
  const spend7d = spendSeries14d.slice(7).reduce((a, b) => a + b, 0);

  const settled7 = tasks14.filter(
    (t) =>
      (t.finishedAt ?? t.createdAt) >= since7 &&
      (t.status === "completed" || t.status === "error"),
  );
  const completed = settled7.filter((t) => t.status === "completed").length;
  const failed = settled7.length - completed;
  const prs7d = new Set(
    tasks14
      .filter((t) => t.prUrl && t.createdAt >= since7)
      .map((t) => t.prUrl!),
  ).size;

  return {
    spendToday,
    spend7d,
    spendSeries14d,
    runs7d: {
      completed,
      failed,
      successRate:
        settled7.length > 0 ? completed / settled7.length : null,
    },
    prs7d,
    sandboxes: { cloud: cloudUp, local: localUp },
    featuresInReview,
    plansAwaiting,
  };
}
