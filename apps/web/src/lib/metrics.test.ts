import assert from "node:assert/strict";
import { test } from "node:test";
import { subDays } from "date-fns";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import { getWorkspaceMetrics } from "./metrics";

test("workspace metrics: spend buckets, success rate, PR dedupe, scoping", async () => {
  const ws = await prisma.workspace.create({
    data: { id: "ws-metrics", name: "Metrics" },
  });
  const other = await prisma.workspace.create({
    data: { id: "ws-other", name: "Other" },
  });
  const [project, foreign] = await Promise.all([
    prisma.project.create({ data: { name: "mine", workspaceId: ws.id } }),
    prisma.project.create({ data: { name: "theirs", workspaceId: other.id } }),
  ]);
  const mkSandbox = (projectId: string, provider: string, status = "running") =>
    prisma.sandbox.create({
      data: {
        projectId,
        name: `sb-${provider}-${status}`,
        provider,
        status,
        region: "lon1",
        size: "s",
        workDir: "/tmp/m",
      },
    });
  const [cloud, local, foreignSb] = await Promise.all([
    mkSandbox(project.id, "civo"),
    mkSandbox(project.id, "local"),
    mkSandbox(foreign.id, "civo"),
  ]);
  await mkSandbox(project.id, "civo", "destroyed"); // down = not counted

  const now = new Date();
  const mkTask = (
    sandboxId: string,
    daysAgo: number,
    status: string,
    costUsd: number | null,
    prUrl: string | null = null,
  ) =>
    prisma.sandboxTask.create({
      data: {
        sandboxId,
        kind: "task",
        prompt: "p",
        workDir: "/tmp/m",
        status,
        costUsd,
        prUrl,
        createdAt: subDays(now, daysAgo),
        finishedAt: subDays(now, daysAgo),
      },
    });

  const PR = "https://git.example.com/x/y/-/merge_requests/1";
  await Promise.all([
    mkTask(cloud.id, 0, "completed", 2.5, PR),
    // A follow-up repeating its parent's PR must not count twice.
    mkTask(cloud.id, 1, "completed", 1.0, PR),
    mkTask(cloud.id, 2, "error", 0.5),
    // Inside the 14d sparkline, outside the 7d sums.
    mkTask(local.id, 10, "completed", 4.0),
    // Another workspace's spend must not leak in.
    mkTask(foreignSb.id, 0, "completed", 99.0, "https://github.com/a/b/pull/9"),
  ]);
  await prisma.feature.create({
    data: { projectId: project.id, title: "f", status: "in_review" },
  });
  await prisma.plan.create({
    data: {
      projectId: project.id,
      title: "plan",
      content: "c",
      status: "draft",
    },
  });

  const m = await getWorkspaceMetrics(ws.id);

  assert.equal(m.spendSeries14d.length, 14, "always a full fortnight");
  assert.equal(m.spendToday, 2.5);
  assert.equal(m.spend7d, 4.0, "2.5 + 1.0 + 0.5 — the 10-day-old $4 stays out");
  assert.equal(m.spendSeries14d[3], 4.0, "…but it shows in the sparkline");
  assert.equal(m.runs7d.completed, 2);
  assert.equal(m.runs7d.failed, 1);
  assert.ok(Math.abs((m.runs7d.successRate ?? 0) - 2 / 3) < 1e-9);
  assert.equal(m.prs7d, 1, "same PR twice counts once");
  assert.deepEqual(m.sandboxes, { cloud: 1, local: 1 });
  assert.equal(m.featuresInReview, 1);
  assert.equal(m.plansAwaiting, 1);

  const empty = await getWorkspaceMetrics("ws-nonexistent");
  assert.equal(empty.spend7d, 0);
  assert.equal(empty.runs7d.successRate, null, "no runs → no rate, not 0%");
});
