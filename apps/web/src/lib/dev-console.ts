// Dedicated dev sandbox: a chat-style prompt queue against a long-lived
// sandbox. No PR pipeline, no branch ceremony — the user drives git. Each
// prompt resumes the sandbox's continuous Claude session (devSessionId);
// prompts sent while one is running queue up and run in order.

import { mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { prisma, type SandboxTask } from "@nexux/db";
import { getConfig } from "@nexux/config";
import { AGENT_USER, execRemote, runAgentTask } from "@nexux/sandbox";
import { notifyDevTask } from "@/lib/notify";
import { latestPlanContent } from "@/lib/plan-runner";
import {
  acquireSandboxLock,
  buildSearchContext,
  collectScreenshots,
  createLogWriter,
  loadAgents,
  loadSkills,
  materializeContext,
  pushAttachments,
  releaseSandboxLock,
  renderScreenshotSection,
  resolveWorkDir,
} from "@/lib/task-manager";
import {
  buildDevPrompt,
  buildFeaturePrompt,
  detectNeedsInput,
  extractPrUrls,
  gitlabAppendMrSectionCommand,
  gitlabUploadShotsCommand,
  mrRefFromUrl,
  NEEDS_INPUT_MARKER,
  parseShotUploads,
  REMOTE_SHOT_DIR,
  sandboxReachable,
  sandboxTarget,
} from "@/lib/agent-core";
export { detectNeedsInput, NEEDS_INPUT_MARKER };

const globalForDev = globalThis as unknown as {
  nexuxDevWorkers: Set<string> | undefined;
  nexuxDevAborts: Map<string, AbortController> | undefined;
};
// One drain loop per sandbox; survives HMR module reloads like the task lock.
const activeWorkers = (globalForDev.nexuxDevWorkers ??= new Set<string>());
// Abort handle per RUNNING dev task — lets the chat's stop button kill it.
const runningAborts = (globalForDev.nexuxDevAborts ??= new Map<
  string,
  AbortController
>());

const DEFAULT_DEV_TIMEOUT_MIN = 45;
const LOCK_RETRY_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Attachments -----------------------------------------------------------

/** One file the user sent with a dev prompt. `path` = host staging location. */
export type DevAttachment = {
  name: string;
  mime: string;
  size: number;
  path: string;
};

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // per prompt, total
export const MAX_ATTACHMENT_COUNT = 10;

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-()\[\] ]+/g, "_");
  return base || "file";
}

/**
 * Stage uploaded files on the host before the task exists: the queue worker
 * may grab a task the instant it's created, so files must be on disk first.
 */
export async function stageDevAttachments(
  files: Array<{ name: string; mime: string; data: Buffer }>,
): Promise<DevAttachment[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Too many attachments (max ${MAX_ATTACHMENT_COUNT})`);
  }
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `Attachments too large (${(total / 1024 / 1024).toFixed(1)} MB — max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per prompt)`,
    );
  }
  const dir = path.join(getConfig().dataDir, "dev-attachments", randomUUID());
  await mkdir(dir, { recursive: true });
  const staged: DevAttachment[] = [];
  const used = new Set<string>();
  for (const f of files) {
    let name = sanitizeFilename(f.name);
    // Two files with the same name in one prompt: keep both.
    for (let i = 2; used.has(name); i++) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)}-${i}${ext}`;
    }
    used.add(name);
    const abs = path.join(dir, name);
    await writeFile(abs, f.data);
    staged.push({
      name,
      mime: f.mime || "application/octet-stream",
      size: f.data.length,
      path: abs,
    });
  }
  return staged;
}

/**
 * Queue a prompt on a dedicated sandbox. Returns the queued task; execution
 * happens in the background, strictly in order per sandbox.
 */
export async function enqueueDevPrompt(
  projectId: string,
  sandboxId: string,
  prompt: string,
  opts?: { featureId?: string | null; attachments?: DevAttachment[] },
): Promise<SandboxTask> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");
  if (!sandbox.dedicated) {
    throw new Error("This sandbox is not marked as a dev sandbox");
  }
  if (!sandboxReachable(sandbox)) {
    throw new Error("Sandbox is not running");
  }
  const workDir = await resolveWorkDir(projectId);
  const task = await prisma.sandboxTask.create({
    data: {
      sandboxId,
      kind: "dev",
      prompt,
      workDir,
      status: "queued",
      featureId: opts?.featureId ?? null,
      attachments: opts?.attachments?.length ? opts.attachments : undefined,
    },
  });
  kickDevWorker(sandboxId);
  return task;
}

/** Cancel a still-queued dev prompt. No-op if it already started. */
export async function cancelDevPrompt(taskId: string): Promise<boolean> {
  const res = await prisma.sandboxTask.updateMany({
    where: { id: taskId, kind: "dev", status: "queued" },
    data: { status: "canceled", finishedAt: new Date() },
  });
  return res.count > 0;
}

/**
 * Stop a RUNNING dev prompt: kill the host-side transport (via its abort
 * controller) and, best-effort, the headless CLI inside the sandbox — the
 * transport kill alone doesn't always reach the remote process. The worker
 * loop sees the abort and marks the task canceled.
 */
export async function stopDevTask(taskId: string): Promise<boolean> {
  const task = await prisma.sandboxTask.findFirst({
    where: { id: taskId, kind: "dev", status: "running" },
    include: { sandbox: true },
  });
  if (!task) return false;

  const controller = runningAborts.get(taskId);
  if (controller) controller.abort();

  // Belt and braces: kill the agent user's headless CLI in the sandbox.
  // Patterns match only the non-interactive invocations we launch — the
  // user's own interactive `claude` in the terminal is untouched.
  try {
    const rootTarget = sandboxTarget(task.sandbox, task.workDir, "root");
    await execRemote(
      `pkill -u ${AGENT_USER} -f -- '--output-format stream-json' 2>/dev/null; pkill -u ${AGENT_USER} -f -- 'opencode run' 2>/dev/null; true`,
      { ...rootTarget, timeoutMs: 20_000 },
    ).catch(() => undefined);
  } catch {
    // Sandbox unreachable — the local kill already stopped the run.
  }

  // If the worker isn't around to finalize (e.g. dead process), settle the
  // row here; the worker's own update is a no-op afterwards.
  if (!controller) {
    await prisma.sandboxTask.updateMany({
      where: { id: taskId, status: "running" },
      data: {
        status: "canceled",
        error: "Stopped by the user",
        finishedAt: new Date(),
      },
    });
  }
  return true;
}

/**
 * Forget the continuous Claude session AND wipe the chat transcript — the
 * next prompt starts cold in an empty console. Queued/running prompts are
 * left alone: the worker still owns those rows and updates them by id.
 */
export async function resetDevSession(sandboxId: string): Promise<void> {
  await prisma.sandbox.update({
    where: { id: sandboxId },
    data: { devSessionId: null },
  });

  const settled = await prisma.sandboxTask.findMany({
    where: {
      sandboxId,
      kind: "dev",
      status: { in: ["completed", "error", "canceled"] },
    },
    select: { id: true, attachments: true },
  });
  if (settled.length === 0) return;

  await prisma.sandboxTask.deleteMany({
    where: { id: { in: settled.map((t) => t.id) } },
  });

  // Staged attachment files live under dataDir/dev-attachments/<uuid>/, one
  // dir per prompt. Best-effort, and never outside that root.
  const root = path.join(getConfig().dataDir, "dev-attachments");
  const dirs = new Set<string>();
  for (const t of settled) {
    for (const a of (t.attachments as DevAttachment[] | null) ?? []) {
      const dir = path.dirname(a.path);
      if (dir.startsWith(root + path.sep)) dirs.add(dir);
    }
  }
  await Promise.all(
    [...dirs].map((d) =>
      rm(d, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
}

/**
 * Persist the session a finished run leaves behind — but only if nobody
 * reset the console while it ran. Compare-and-swap against the id the run
 * started from: a reset nulls devSessionId mid-run, the swap misses, and
 * the fresh state survives instead of being silently resurrected. (A reset
 * during a sandbox's very FIRST run still saves — both sides are null; the
 * stop button, not reset, is the tool against a run in progress.)
 */
export async function saveDevSessionId(
  sandboxId: string,
  startedFrom: string | null,
  next: string,
): Promise<boolean> {
  const res = await prisma.sandbox.updateMany({
    where: { id: sandboxId, devSessionId: startedFrom },
    data: { devSessionId: next },
  });
  return res.count > 0;
}

/** Start the per-sandbox drain loop if it isn't already running. */
export function kickDevWorker(sandboxId: string): void {
  if (activeWorkers.has(sandboxId)) return;
  activeWorkers.add(sandboxId);
  void drainQueue(sandboxId)
    .catch((err) => console.error("[nexux] dev worker crashed:", err))
    .finally(() => activeWorkers.delete(sandboxId));
}

async function drainQueue(sandboxId: string): Promise<void> {
  for (;;) {
    const next = await prisma.sandboxTask.findFirst({
      where: { sandboxId, kind: "dev", status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (!next) return;
    // A PR-pipeline task may hold the sandbox — wait our turn instead of
    // fighting over the working tree.
    if (!acquireSandboxLock(sandboxId)) {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      await runDevTask(next.id);
    } finally {
      releaseSandboxLock(sandboxId);
    }
  }
}

async function runDevTask(taskId: string): Promise<void> {
  const task = await prisma.sandboxTask.findUnique({
    where: { id: taskId },
    include: { sandbox: true },
  });
  if (!task || task.status !== "queued") return;
  const sandbox = task.sandbox;

  const fail = async (message: string) => {
    await prisma.sandboxTask
      .update({
        where: { id: taskId },
        data: { status: "error", error: message, finishedAt: new Date() },
      })
      .catch(() => undefined);
    if (task?.featureId) {
      await prisma.feature
        .update({ where: { id: task.featureId }, data: { status: "todo" } })
        .catch(() => undefined);
    }
    void notifyDevTask(taskId).catch(() => undefined);
  };

  if (!sandboxReachable(sandbox)) {
    return fail("Sandbox is not running — prompt could not be delivered");
  }

  await prisma.sandboxTask.update({
    where: { id: taskId },
    data: { status: "running", phase: "agent" },
  });
  // Board-queued feature: reflect progress on the kanban while it runs.
  if (task.featureId) {
    await prisma.feature
      .update({
        where: { id: task.featureId },
        data: { status: "in_progress" },
      })
      .catch(() => undefined);
  }

  const log = createLogWriter(taskId);
  try {
    const cfg = await prisma.sandboxConfig.findUnique({
      where: { projectId: sandbox.projectId },
    });
    let sessionAtStart: string | null = sandbox.devSessionId;
    const resumed = Boolean(sessionAtStart);
    const brain = cfg?.brain ?? "claude";
    log.append(
      `[nexux] dev prompt → ${brain === "opencode" ? "OpenCode" : "Claude"} (${resumed ? "resuming session" : "new session"})`,
    );

    // Same context every session gets: selected subagents and skills as native
    // ~/.claude files, plus the task prompt's semantic index hits — parity with
    // the task pipeline.
    const [agents, skills, searchContext] = await Promise.all([
      loadAgents(sandbox.projectId),
      loadSkills(sandbox.projectId),
      buildSearchContext(sandbox.projectId, task.prompt),
    ]);
    if (agents.length > 0 || skills.length > 0) {
      log.append(
        `[nexux] installing ${agents.length} agent${agents.length !== 1 ? "s" : ""} and ${skills.length} skill${skills.length !== 1 ? "s" : ""} into ~/.claude`,
      );
    }
    await materializeContext(
      { ...sandboxTarget(sandbox, task.workDir), onLog: log.sink.bind(log) },
      { agents, skills },
    );

    // Files sent with the prompt: staged on the host at enqueue, pushed into
    // the sandbox here so the agent can Read them (images included).
    const remoteAttachments = await pushAttachments({
      target: sandboxTarget(sandbox, task.workDir),
      rootTarget: sandboxTarget(sandbox, task.workDir, "root"),
      taskId: task.id,
      attachments: (task.attachments as DevAttachment[] | null) ?? [],
      log: log.append.bind(log),
    });

    // The chat's stop button aborts this controller (see stopDevTask).
    const abort = new AbortController();
    runningAborts.set(taskId, abort);
    // A paused/upgraded sandbox can lose the continuous session state; the
    // CLI then dies with "No conversation found with session ID". Detect
    // that exact signature in the stream and retry once with a fresh
    // session instead of bricking the chat until a manual reset.
    let staleSession = false;
    const onLog = (chunk: string) => {
      if (chunk.includes("No conversation found with session ID")) {
        staleSession = true;
      }
      log.sink(chunk);
    };
    const runOpts = {
      ...sandboxTarget(sandbox, task.workDir),
      onLog,
      timeoutMs:
        (cfg?.taskTimeoutMinutes ?? DEFAULT_DEV_TIMEOUT_MIN) * 60_000,
      signal: abort.signal,
      model:
        (brain === "opencode" ? cfg?.openCodeModel : cfg?.claudeModel) ??
        undefined,
    };
    const devPrompt = (isResumed: boolean) =>
      buildDevPrompt({
        task: task.prompt,
        workDir: task.workDir,
        resumed: isResumed,
        instructions: cfg?.agentInstructions ?? null,
        searchContext,
        attachments: remoteAttachments,
      });
    let res;
    try {
      res = await runAgentTask(brain, devPrompt(resumed), {
        ...runOpts,
        resumeSessionId: sandbox.devSessionId ?? undefined,
      });
      if (!res.ok && resumed && staleSession && !abort.signal.aborted) {
        log.append(
          "[nexux] stored session no longer exists on the sandbox — starting a fresh one",
        );
        await prisma.sandbox
          .update({ where: { id: sandbox.id }, data: { devSessionId: null } })
          .catch(() => undefined);
        sessionAtStart = null;
        res = await runAgentTask(brain, devPrompt(false), runOpts);
      }
    } finally {
      runningAborts.delete(taskId);
    }

    if (abort.signal.aborted) {
      log.append("[nexux] stopped by the user");
      await prisma.sandboxTask.updateMany({
        where: { id: taskId, status: "running" },
        data: {
          status: "canceled",
          error: "Stopped by the user",
          finishedAt: new Date(),
        },
      });
      if (task.featureId) {
        await prisma.feature
          .update({ where: { id: task.featureId }, data: { status: "todo" } })
          .catch(() => undefined);
      }
      return;
    }

    if (res.sessionId) {
      const saved = await saveDevSessionId(
        sandbox.id,
        sessionAtStart,
        res.sessionId,
      ).catch(() => false);
      if (!saved) {
        log.append(
          "[nexux] session was reset while this ran — keeping the fresh state",
        );
      }
    }

    if (!res.ok) {
      return fail(res.error ?? "Agent run failed");
    }

    // Screenshots the agent saved for this prompt (e.g. "show me the home page").
    // Archive the remote dir after collecting so the next prompt in this chat
    // doesn't resend the same images.
    const target = sandboxTarget(sandbox, task.workDir);
    const prUrl = extractPrUrls(res.result)[0] ?? null;
    const shots = await collectScreenshots(target, taskId).catch(() => []);
    if (shots.length > 0) {
      log.append(`[nexux] collected ${shots.length} screenshot(s)`);
      // A chat that opened a GitLab MR gets its screenshots embedded in the
      // MR description — the pipeline's behaviour, ported to the dev console
      // where the agent itself runs glab. Best-effort: a failed upload never
      // fails the prompt. Must run BEFORE the archive empties the remote dir.
      const mrRef = prUrl ? mrRefFromUrl(prUrl) : null;
      if (mrRef) {
        try {
          const up = await execRemote(
            gitlabUploadShotsCommand({ host: mrRef.host, path: mrRef.path }),
            { ...target, timeoutMs: 180_000 },
          );
          const links = parseShotUploads(up.stdout, mrRef);
          if (links.length > 0) {
            const section = renderScreenshotSection(links, shots, true);
            const sectionFile = `/tmp/nexux-mr-shots-${taskId}.md`;
            await execRemote(
              `cat > ${sectionFile} <<'NEXUX_MD_EOF'\n${section}\nNEXUX_MD_EOF`,
              { ...target, timeoutMs: 30_000 },
            );
            const appended = await execRemote(
              gitlabAppendMrSectionCommand(mrRef, sectionFile),
              { ...target, timeoutMs: 60_000 },
            );
            log.append(
              appended.stdout.includes("NEXUX_MR_APPENDED")
                ? `[nexux] ${links.length} screenshot(s) embedded in MR !${mrRef.iid}`
                : `[nexux] WARN: could not embed screenshots in MR !${mrRef.iid}: ${appended.stderr.trim().slice(-200)}`,
            );
          } else {
            log.append(
              `[nexux] WARN: screenshot upload to GitLab returned no links`,
            );
          }
        } catch (err) {
          log.append(
            `[nexux] WARN: MR screenshot embed failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await execRemote(
        `mv ${REMOTE_SHOT_DIR} ${REMOTE_SHOT_DIR}-sent-$(date +%s) || true`,
        { ...target, timeoutMs: 30_000 },
      ).catch(() => undefined);
    }

    const needsInput = detectNeedsInput(res.result);
    log.append(
      needsInput
        ? "[nexux] done — the agent is asking for direction"
        : "[nexux] done",
    );
    await prisma.sandboxTask.update({
      where: { id: taskId },
      data: {
        status: "completed",
        // Surfaced as a distinct state in UI/Telegram: the agent stopped
        // because it wants an answer, not because the work is finished.
        phase: needsInput ? "needs_input" : null,
        result: res.result ?? null,
        sessionId: res.sessionId ?? null,
        // A PR the user asked for in chat only exists in the reply text —
        // captured here so the chat and the feature board can link to it.
        prUrl,
        costUsd: res.costUsd ?? null,
        durationMs: res.durationMs ?? null,
        finishedAt: new Date(),
      },
    });
    if (task.featureId) {
      await prisma.feature
        .update({
          where: { id: task.featureId },
          data: { status: "in_review" },
        })
        .catch(() => undefined);
    }
    void notifyDevTask(taskId).catch(() => undefined);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  } finally {
    await log.close();
  }
}

/**
 * Board queue -> dev sandbox: send every feature sitting in the "queued"
 * column to the project's dedicated running sandbox, oldest first. Features
 * already dispatched (a live dev task references them) are skipped. No dev
 * sandbox -> no-op; they wait on the board until one exists.
 */
export async function flushFeatureQueue(projectId: string): Promise<number> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { projectId, dedicated: true, status: "running", archived: false },
    orderBy: { createdAt: "desc" },
  });
  if (!sandbox || !sandboxReachable(sandbox)) return 0;

  const queued = await prisma.feature.findMany({
    where: { projectId, status: "queued" },
    orderBy: [{ order: "asc" }, { updatedAt: "asc" }],
  });
  let sent = 0;
  for (const feature of queued) {
    const inFlight = await prisma.sandboxTask.findFirst({
      where: {
        featureId: feature.id,
        kind: "dev",
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    if (inFlight) continue;
    await enqueueDevPrompt(
      projectId,
      sandbox.id,
      buildFeaturePrompt({
        ...feature,
        planContent: await latestPlanContent(feature.id),
      }),
      {
        featureId: feature.id,
        attachments: (feature.attachments as DevAttachment[] | null) ?? [],
      },
    );
    sent++;
  }
  return sent;
}

/**
 * Boot recovery: dev tasks left "running" by a crashed/restarted server can
 * never finish (their driver died) — mark them and resume draining queues.
 */
export async function recoverDevQueues(): Promise<void> {
  const orphaned = await prisma.sandboxTask.findMany({
    where: { kind: "dev", status: "running" },
    select: { id: true },
  });
  for (const t of orphaned) {
    await prisma.sandboxTask
      .update({
        where: { id: t.id },
        data: {
          status: "error",
          error: "Interrupted by a server restart — resend the prompt",
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    void notifyDevTask(t.id).catch(() => undefined);
  }
  const queued = await prisma.sandboxTask.findMany({
    where: { kind: "dev", status: "queued" },
    select: { sandboxId: true },
    distinct: ["sandboxId"],
  });
  for (const q of queued) kickDevWorker(q.sandboxId);

  // Features parked in the board's Queue column while no dev sandbox (or
  // server) was available — dispatch them now if one is running.
  const parked = await prisma.feature.findMany({
    where: { status: "queued" },
    select: { projectId: true },
    distinct: ["projectId"],
  });
  for (const f of parked) {
    void flushFeatureQueue(f.projectId).catch(() => undefined);
  }
}
