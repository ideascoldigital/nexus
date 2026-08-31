import assert from "node:assert/strict";
import { test } from "node:test";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures.
import "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import {
  enqueuePlanRun,
  latestPlanContent,
  recoverPlanRuns,
} from "./plan-runner";

// The happy path needs a live sandbox over ssh — covered by hand. What is
// covered here: the guards that keep planning honest (no dev sandbox, one
// plan per feature), the plan the implementer receives, and boot recovery.

async function makeProject(name: string) {
  return prisma.project.create({ data: { name } });
}

test("planning without a running dev sandbox is refused", async () => {
  const project = await makeProject("no-sandbox");
  const feature = await prisma.feature.create({
    data: { projectId: project.id, title: "F" },
  });
  await assert.rejects(
    enqueuePlanRun(project.id, feature.id),
    /No running dev sandbox/,
  );
});

test("a feature with a plan run in flight is refused a second one", async () => {
  const project = await makeProject("in-flight");
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId: project.id,
      name: "sb-plan",
      status: "running",
      dedicated: true,
      publicIp: "10.0.0.9",
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb-plan",
    },
  });
  const feature = await prisma.feature.create({
    data: { projectId: project.id, title: "F" },
  });
  await prisma.sandboxTask.create({
    data: {
      sandboxId: sandbox.id,
      featureId: feature.id,
      kind: "plan",
      prompt: "Plan: F",
      workDir: "/tmp/sb-plan",
      status: "running",
    },
  });
  await assert.rejects(
    enqueuePlanRun(project.id, feature.id),
    /already has a plan run in flight/,
  );
});

test("latestPlanContent prefers the newest non-rejected plan", async () => {
  const project = await makeProject("plans");
  const feature = await prisma.feature.create({
    data: { projectId: project.id, title: "F" },
  });
  assert.equal(await latestPlanContent(feature.id), null);

  await prisma.plan.create({
    data: {
      projectId: project.id,
      featureId: feature.id,
      title: "old",
      content: "old plan",
      status: "draft",
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    },
  });
  await prisma.plan.create({
    data: {
      projectId: project.id,
      featureId: feature.id,
      title: "new",
      content: "new plan",
      status: "approved",
      updatedAt: new Date("2026-08-02T00:00:00Z"),
    },
  });
  // The newest plan being rejected must NOT resurrect it for the implementer.
  await prisma.plan.create({
    data: {
      projectId: project.id,
      featureId: feature.id,
      title: "bad",
      content: "rejected plan",
      status: "rejected",
      updatedAt: new Date("2026-08-03T00:00:00Z"),
    },
  });

  assert.equal(await latestPlanContent(feature.id), "new plan");
});

test("boot recovery settles orphaned plan runs and leaves the rest alone", async () => {
  const project = await makeProject("recovery");
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId: project.id,
      name: "sb-rec",
      status: "running",
      dedicated: true,
      publicIp: "10.0.0.10",
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb-rec",
    },
  });
  const mk = (kind: string, status: string) =>
    prisma.sandboxTask.create({
      data: {
        sandboxId: sandbox.id,
        kind,
        prompt: "p",
        workDir: "/tmp/sb-rec",
        status,
      },
    });
  const orphan = await mk("plan", "running");
  const devRun = await mk("dev", "running");
  const donePlan = await mk("plan", "completed");

  await recoverPlanRuns();

  assert.equal(
    (await prisma.sandboxTask.findUnique({ where: { id: orphan.id } }))?.status,
    "error",
  );
  assert.equal(
    (await prisma.sandboxTask.findUnique({ where: { id: devRun.id } }))?.status,
    "running",
    "dev prompts belong to recoverDevQueues",
  );
  assert.equal(
    (await prisma.sandboxTask.findUnique({ where: { id: donePlan.id } }))
      ?.status,
    "completed",
  );
});
