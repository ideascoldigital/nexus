// Spec 24, piece 4 — "would this boot?", answered from what we can know.
//
// Two sources, deliberately kept apart in the result:
//
//   static   — the definition checks in lib/stack/validate.ts. Cheap, always
//              available, and the only half that exists before a provision.
//   observed — the `boot:*` / `install:*` / `stack:up` steps a real bootstrap
//              recorded (pieces 1 and 2), read back from the most recent
//              sandbox of this project.
//
// The second is what actually answers the question, and it is also the half
// that may be absent or stale. Reporting them as one verdict would mean either
// claiming a definition boots because it passed a lint, or claiming it is
// unvalidated because nobody has provisioned it yet — both are worse than
// saying which is which.

import { prisma } from "@nexux/db";
import {
  bootstrapReportCommand,
  execRemote,
  parseBootstrapReport,
  type BootstrapStep,
} from "@nexux/sandbox";

import { sandboxTarget } from "@/lib/agent-core";
import { nodePhases } from "@/lib/stack/phases";
import { validateStack, type ValidationFinding } from "@/lib/stack/validate";
import type { StackNodeDTO } from "@/lib/stack/types";

export type StackValidation = {
  ok: boolean;
  findings: ValidationFinding[];
  /** What a real bootstrap recorded, when one is reachable. */
  observed: ObservedRun | null;
};

export type ObservedRun = {
  sandboxId: string;
  sandboxName: string;
  sandboxStatus: string;
  /** When that sandbox was created — how stale this evidence is. */
  provisionedAt: string;
  steps: BootstrapStep[];
  failed: BootstrapStep[];
  /** True when at least one boot:* step ran and all of them passed. */
  booted: boolean | null;
  /** Why there is no evidence, when there is none. */
  unavailable?: string;
};

/**
 * The static half. No sandbox, no docker, no network — safe to call on every
 * canvas save if a caller ever wants to.
 */
export async function validateProjectStack(
  projectId: string,
): Promise<{ ok: boolean; findings: ValidationFinding[] }> {
  const [nodes, edges, repos] = await Promise.all([
    prisma.stackNode.findMany({ where: { projectId } }),
    prisma.stackEdge.findMany({
      where: { projectId },
      select: { sourceId: true, targetId: true },
    }),
    prisma.repository.findMany({
      where: { projectId },
      select: { id: true, localPath: true },
    }),
  ]);

  return validateStack({
    nodes: nodes as unknown as StackNodeDTO[],
    edges,
    repoHasLocalPath: new Map(repos.map((r) => [r.id, Boolean(r.localPath)])),
  });
}

/**
 * The observed half: the step report from this project's most recent sandbox.
 *
 * Most recent rather than "a healthy one": a sandbox that failed to provision
 * is the most informative evidence there is, and skipping it in favour of an
 * older green one would report a stack as working *because* its latest attempt
 * broke.
 */
export async function readObservedRun(
  projectId: string,
): Promise<ObservedRun | null> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  if (!sandbox) return null;

  const base: ObservedRun = {
    sandboxId: sandbox.id,
    sandboxName: sandbox.name,
    sandboxStatus: sandbox.status,
    provisionedAt: sandbox.createdAt.toISOString(),
    steps: [],
    failed: [],
    booted: null,
  };

  // A sandbox that is not running cannot be asked. That is an answer, not an
  // error: it says the evidence exists but is out of reach, which is different
  // from a project nobody has ever provisioned.
  if (sandbox.status !== "running") {
    return { ...base, unavailable: `The sandbox is ${sandbox.status}.` };
  }

  let stdout: string;
  try {
    const res = await execRemote(bootstrapReportCommand(), {
      ...sandboxTarget(sandbox, "/", "root"),
      timeoutMs: 30_000,
    });
    stdout = res.stdout;
  } catch (err) {
    return {
      ...base,
      unavailable: `Could not reach the sandbox: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const report = parseBootstrapReport(stdout);
  if (report.steps.length === 0) {
    // Provisioned before the recorder existed (or bootstrap never got there).
    return {
      ...base,
      unavailable:
        "That sandbox recorded no steps — it predates step reporting. Re-create it to get one.",
    };
  }

  // Latest record per step wins: the retry action re-runs clone/install/build,
  // and reporting a repaired step as still broken is what made the old
  // WARN-scraping misleading.
  const latest = new Map<string, BootstrapStep>();
  for (const step of report.steps) latest.set(step.step, step);
  const steps = [...latest.values()];
  const bootSteps = steps.filter((s) => s.step.startsWith("boot:"));

  return {
    ...base,
    steps,
    failed: steps.filter((s) => s.exitCode !== 0),
    // Null, not false, when nothing was probed: "no app declared a port" and
    // "the app failed to start" are different answers.
    booted: bootSteps.length
      ? bootSteps.every((s) => s.exitCode === 0)
      : null,
  };
}

/** Both halves, for the Validate action. */
export async function validateProject(
  projectId: string,
): Promise<StackValidation> {
  const [stat, observed] = await Promise.all([
    validateProjectStack(projectId),
    readObservedRun(projectId).catch(() => null),
  ]);
  return { ...stat, observed };
}

/**
 * The stack graph as the definition half of an MCP answer.
 *
 * Phases rather than the legacy columns: they are the source of truth (spec
 * 17), and a caller deciding what to patch should be reading the same shape
 * the PUT route writes.
 */
export async function describeStack(projectId: string) {
  const [nodes, edges] = await Promise.all([
    prisma.stackNode.findMany({
      where: { projectId },
      include: { repository: { select: { id: true, name: true } } },
    }),
    prisma.stackEdge.findMany({
      where: { projectId },
      select: { sourceId: true, targetId: true },
    }),
  ]);

  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      runMode: n.runMode,
      image: n.image,
      repository: n.repository,
      ports: n.ports,
      env: n.env,
      phases: nodePhases(n),
    })),
    edges,
  };
}
