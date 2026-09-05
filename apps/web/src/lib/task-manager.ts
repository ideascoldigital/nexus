import fs from "fs";
import path from "path";
import { prisma, type SandboxTask } from "@nexux/db";
import { getConfig } from "@nexux/config";
import { searchProject } from "@nexux/embeddings";
import { notifyTaskFinished } from "@/lib/notify";
import {
  AGENT_USER,
  SANDBOX_ROOT,
  execRemote,
  fetchRemoteDir,
  pickMainRepo,
  pushLocalDir,
  repoDir,
  runAgentTask,
  safeSlug,
} from "@nexux/sandbox";
import os from "os";
import { randomUUID } from "crypto";
import { branchName, conventionalTitle } from "@/lib/branch-name";
import { getStackInheritance } from "@/lib/stack/sandbox-inheritance";

// One task per sandbox at a time: concurrent Claude runs in the same checkout
// would fight over the working tree.
const globalForTasks = globalThis as unknown as {
  nexuxTaskOps: Set<string> | undefined;
};
const busySandboxes = (globalForTasks.nexuxTaskOps ??= new Set<string>());

export function isSandboxBusy(sandboxId: string): boolean {
  return busySandboxes.has(sandboxId);
}

/** Take the one-task-per-sandbox lock. False = something else is running. */
export function acquireSandboxLock(sandboxId: string): boolean {
  if (busySandboxes.has(sandboxId)) return false;
  busySandboxes.add(sandboxId);
  return true;
}

export function releaseSandboxLock(sandboxId: string): void {
  busySandboxes.delete(sandboxId);
}

// Pure delegation logic lives in agent-core.ts (unit-tested, prisma-free);
// re-exported here so existing importers keep working.
import {
  DEFAULT_POLICY,
  buildAgentPrompt,
  renderAttachmentsSection,
  buildFeaturePrompt,
  buildFollowUpPrompt,
  deliverySweepCommand,
  gitlabUploadShotsCommand,
  parseDeliverySweep,
  parseGitRemote,
  parseShotUploads,
  policyModel,
  prUrlMatchesRepo,
  renderAgentFile,
  renderLivePreviewScript,
  renderSkillFile,
  sandboxReachable,
  sandboxTarget,
  withFeaturePrOverride,
  HEADLESS_RULES,
  PREVIEW_APP_PID,
  PREVIEW_TUNNEL_PID,
  REMOTE_SHOT_DIR,
  type AgentDef,
  type AgentPolicy,
  type DeliveryTarget,
  type SandboxTarget,
  type SkillDef,
} from "@/lib/agent-core";
export {
  buildAgentPrompt,
  buildFeaturePrompt,
  buildFollowUpPrompt,
  sandboxReachable,
  sandboxTarget,
  HEADLESS_RULES,
  REMOTE_SHOT_DIR,
};

/** Remote checkout dir for a project's main repo (falls back to /opt/nexus). */
export async function resolveWorkDir(projectId: string): Promise<string> {
  // Cloneable OR local-only (bootstrap/mounted) repos both live under
  // /opt/nexux/<slug> on the sandbox.
  const repos = await prisma.repository.findMany({ where: { projectId } });
  // Same picker the bootstrap marks fatal, so the directory a task cds into is
  // by construction the one whose clone failure aborts provisioning.
  const main = pickMainRepo(repos);
  return main ? repoDir(main.name) : SANDBOX_ROOT;
}

/**
 * The command that boots the app for screenshots / live preview.
 *
 * The repo's own setup wins when set — it is the explicit choice. Otherwise
 * fall back to the Stack canvas, which already knows how the project runs.
 */
async function resolveRunCommand(projectId: string): Promise<string | null> {
  const repo = await prisma.repository.findFirst({
    where: {
      projectId,
      OR: [{ repoUrl: { not: null } }, { localPath: { not: null } }],
    },
    orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
    include: { setup: true },
  });
  const explicit = repo?.setup?.runCommand?.trim();
  if (explicit) return explicit;
  const { runCommand } = await getStackInheritance(projectId);
  return runCommand;
}

async function loadPolicy(projectId: string): Promise<AgentPolicy> {
  const cfg = await prisma.sandboxConfig.findUnique({ where: { projectId } });
  if (!cfg) return DEFAULT_POLICY;
  // A null previewPort means "whatever the stack says"; only fall back to the
  // old hardcoded default when the canvas cannot answer either.
  const previewPort =
    cfg.previewPort ??
    (await getStackInheritance(projectId)).previewPort ??
    DEFAULT_POLICY.previewPort;
  return {
    baseBranch: cfg.branch,
    createPr: cfg.createPr,
    runTests: cfg.runTests,
    captureScreenshots: cfg.captureScreenshots,
    agentInstructions: cfg.agentInstructions,
    installAgentBrowser: cfg.installAgentBrowser,
    livePreview: cfg.livePreview,
    previewPort,
    brain: cfg.brain,
    claudeModel: cfg.claudeModel ?? null,
    openCodeModel: cfg.openCodeModel ?? null,
    taskTimeoutMinutes:
      cfg.taskTimeoutMinutes ?? DEFAULT_POLICY.taskTimeoutMinutes,
  };
}

/**
 * Query the project's semantic index (repos, definition, features) with the
 * task prompt and render the top hits as a context block for the remote
 * agent. The index and the query embedder (Ollama) only exist locally, so
 * this runs at dispatch time — the sandbox receives the distilled context,
 * not the index. Best-effort: null when Ollama is down or nothing is indexed.
 */
export async function buildSearchContext(
  projectId: string,
  query: string,
): Promise<string | null> {
  try {
    const results = await searchProject(projectId, query, { k: 6 });
    const clip = (s: string, n = 320) =>
      s.replace(/\s+/g, " ").trim().slice(0, n);
    const repoLines = results.repos
      .slice(0, 5)
      .map(
        (h) =>
          `- \`${h.filePath}\`${h.startLine ? ` (lines ${h.startLine}-${h.endLine})` : ""}: ${clip(h.snippet)}`,
      );
    const dataLines = results.projectData
      .slice(0, 3)
      .map(
        (h) =>
          `- [${h.sourceType}] ${h.heading ?? h.filePath}: ${clip(h.snippet)}`,
      );
    if (repoLines.length === 0 && dataLines.length === 0) return null;
    const parts = [
      "The project's semantic index surfaced these as most relevant to the task. Snippets may be stale — read the actual files before relying on them:",
    ];
    if (repoLines.length > 0) parts.push("", "Repository:", ...repoLines);
    if (dataLines.length > 0)
      parts.push("", "Project knowledge (definition, features):", ...dataLines);
    return parts.join("\n");
  } catch {
    return null;
  }
}

/** Skills attached to the project — their guidance is injected into the task. */
export async function loadSkills(projectId: string) {
  const projectSkills = await prisma.projectSkill.findMany({
    where: { projectId },
    include: { skill: true },
  });
  return projectSkills.map((ps) => ps.skill);
}

/** Agents attached to the project — materialized as sandbox subagents. */
export async function loadAgents(projectId: string) {
  const projectAgents = await prisma.projectAgent.findMany({
    where: { projectId },
    include: { agent: true },
  });
  return projectAgents.map((pa) => pa.agent);
}

/** One file staged on the host for a task/feature. Same shape as D-15. */
export type TaskAttachment = {
  name: string;
  mime: string;
  size: number;
  path: string;
};

/**
 * Push staged attachment files into the sandbox at
 * /opt/nexus/.attachments/<taskId>/ and hand back their remote descriptors
 * for the prompt. Best-effort: on failure returns [] and logs a WARN — the
 * run continues without the files rather than dying.
 */
export async function pushAttachments(opts: {
  target: SandboxTarget;
  rootTarget: SandboxTarget;
  taskId: string;
  attachments: TaskAttachment[];
  log: (line: string) => void;
}): Promise<Array<{ name: string; mime: string; remotePath: string }>> {
  const { attachments, taskId, log } = opts;
  if (attachments.length === 0) return [];
  const remoteDir = `/opt/nexus/.attachments/${taskId}`;
  log(`[nexux] uploading ${attachments.length} attachment(s) → ${remoteDir}`);
  try {
    await execRemote(`mkdir -p ${remoteDir}`, {
      ...opts.rootTarget,
      timeoutMs: 30_000,
    });
    // Files may have been staged in several batches (feature uploads) —
    // push each distinct staging dir into the same remote dir.
    const dirs = [...new Set(attachments.map((a) => path.dirname(a.path)))];
    for (const localDir of dirs) {
      const pushed = await pushLocalDir({
        host: opts.rootTarget.host,
        user: opts.rootTarget.user,
        privateKeyPath: opts.rootTarget.privateKeyPath,
        container: opts.rootTarget.container,
        localDir,
        remoteDir,
        timeoutMs: 180_000,
      });
      if (pushed.code !== 0) {
        throw new Error(pushed.stderr.trim().slice(-200) || "copy failed");
      }
    }
    // docker cp / scp land as root — the agent user must read them.
    await execRemote(
      `chown -R ${AGENT_USER}:${AGENT_USER} ${remoteDir} && chmod -R a+rX ${remoteDir}`,
      { ...opts.rootTarget, timeoutMs: 30_000 },
    ).catch(() => undefined);
    return attachments.map((a) => ({
      name: a.name,
      mime: a.mime,
      remotePath: `${remoteDir}/${a.name}`,
    }));
  } catch (err) {
    log(
      `[nexux] WARN: attachment upload failed — continuing without them: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Install the project's selected agents and skills onto the sandbox as native
 * Claude Code context files under the agent user's ~/.claude — subagents at
 * <home>/.claude/agents/<slug>.md, skills at <home>/.claude/skills/<slug>/SKILL.md.
 *
 * Installed into EVERY home whose Claude sessions must see them — the agent
 * user (headless tasks, dev console, VS Code) and root (the in-app terminal) —
 * so whichever way a session is opened, it loads the same subagents and skills.
 * Home dir, not the repo checkout, on purpose: the files must load without
 * ever entering the task's git diff. Contents cross the wire base64-encoded so
 * arbitrary prompt/body text can't break the shell command. A per-home
 * manifest records what we wrote, so an agent/skill de-selected since the last
 * run of a reused sandbox is removed (targeted per-file, never a recursive
 * wipe).
 */
export async function materializeContext(
  ssh: SandboxTarget & { onLog?: (chunk: string) => void },
  ctx: { agents: AgentDef[]; skills: SkillDef[] },
): Promise<void> {
  const files = [
    ...ctx.agents.map((a) => ({
      rel: `agents/${safeSlug(a.name)}.md`,
      content: renderAgentFile(a),
    })),
    ...ctx.skills.map((s) => ({
      rel: `skills/${safeSlug(s.name)}/SKILL.md`,
      content: renderSkillFile(s),
    })),
  ];

  // The whole file set as `<rel>\t<base64>` lines, itself base64-encoded — one
  // safe blob the remote loop decodes and installs into each home.
  const entries = files
    .map((f) => `${f.rel}\t${Buffer.from(f.content, "utf8").toString("base64")}`)
    .join("\n");
  const entriesB64 = Buffer.from(entries, "utf8").toString("base64");

  // Small sets ride inline in the command; big ones blow past execve's
  // per-argument limit ("argument list too long" — seen with 9 agents +
  // 6 skills), so they stage to a temp file and travel like attachments
  // (docker cp / scp), with the script reading the blob from disk.
  let entriesSource = `printf %s '${entriesB64}' | base64 -d`;
  let remoteTmpDir: string | null = null;
  let hostTmpDir: string | null = null;
  if (entriesB64.length > 60_000) {
    remoteTmpDir = `/tmp/nexux-ctx-${randomUUID()}`;
    hostTmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nexux-ctx-"));
    await fs.promises.writeFile(
      path.join(hostTmpDir, "entries.b64"),
      entriesB64,
      "utf8",
    );
    await execRemote(`mkdir -p ${remoteTmpDir}`, { ...ssh, timeoutMs: 30_000 });
    const pushed = await pushLocalDir({
      host: ssh.host,
      user: ssh.user,
      privateKeyPath: ssh.privateKeyPath,
      container: ssh.container,
      localDir: hostTmpDir,
      remoteDir: remoteTmpDir,
      timeoutMs: 120_000,
    }).catch(() => ({ code: -1, stdout: "", stderr: "push failed" }));
    if (pushed.code !== 0) {
      // Same non-fatal contract as the rest of this function: the run
      // continues without the context files rather than dying here.
      ssh.onLog?.(
        `[nexux] WARN: could not stage context files — agents/skills skipped this run\n`,
      );
      await fs.promises.rm(path.join(hostTmpDir, "entries.b64"), { force: true });
      await fs.promises.rmdir(hostTmpDir).catch(() => undefined);
      return;
    }
    entriesSource = `base64 -d < ${remoteTmpDir}/entries.b64`;
  }

  // Best-effort throughout (no `set -e`): a failure writing root's copy (e.g. a
  // local image without sudo) must not cost the agent user's copy.
  const script = `
D_OWN="$HOME"
CAN_ROOT=0; SUDO=""
if [ "$(id -u)" = "0" ]; then
  CAN_ROOT=1
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  CAN_ROOT=1; SUDO="sudo"
fi
HOMES="$D_OWN"
if [ "$D_OWN" != "/root" ] && [ "$CAN_ROOT" = "1" ]; then HOMES="$HOMES /root"; fi

TAB="$(printf '\\t')"
ENTRIES="$(${entriesSource})"

for H in $HOMES; do
  if [ "$H" = "$D_OWN" ]; then W=""; else W="$SUDO"; fi
  D="$H/.claude"; M="$D/.nexux-managed"
  $W mkdir -p "$D"
  # Drop exactly what a previous run left in this home.
  if $W test -f "$M"; then
    $W cat "$M" | while IFS= read -r p || [ -n "$p" ]; do [ -n "$p" ] && $W rm -f "$p"; done
  fi
  $W rm -f "$M"; $W touch "$M"
  printf %s "$ENTRIES" | while IFS="$TAB" read -r rel b64 || [ -n "$rel" ]; do
    [ -n "$rel" ] || continue
    dst="$D/$rel"
    $W mkdir -p "$(dirname "$dst")"
    printf %s "$b64" | base64 -d | $W tee "$dst" >/dev/null
    echo "$dst" | $W tee -a "$M" >/dev/null
  done
  [ "$H" = "/root" ] && $W chown -R root:root "$D" >/dev/null 2>&1 || true
done
`.trim();

  await execRemote(script, { ...ssh, timeoutMs: 60_000 }).catch(() => undefined);

  // Targeted cleanup of the staged blob (never a recursive wipe).
  if (remoteTmpDir) {
    await execRemote(
      `rm -f ${remoteTmpDir}/entries.b64; rmdir ${remoteTmpDir} 2>/dev/null; true`,
      { ...ssh, timeoutMs: 30_000 },
    ).catch(() => undefined);
  }
  if (hostTmpDir) {
    await fs.promises.rm(path.join(hostTmpDir, "entries.b64"), { force: true });
    await fs.promises.rmdir(hostTmpDir).catch(() => undefined);
  }
}

/** Orphan branch that holds review evidence; never merged, never in a diff. */
const ASSETS_BRANCH = "nexux-assets";

/** Local store, served back to the UI: <dataDir>/screenshots/<taskId>/. */
export function taskScreenshotDir(taskId: string): string {
  return path.join(getConfig().dataDir, "screenshots", taskId);
}

/**
 * Screenshots are review evidence, not source. The agent writes them to /tmp
 * (outside the checkout), so they never enter the PR's diff. We then:
 *   1. copy them to Nexus for the local record, and
 *   2. push them to the `nexux-assets` branch via the GitHub contents API,
 *      so the PR description can link to them inside the private repo.
 *
 * GitHub can't render images from a private repo inline (its image proxy
 * fetches anonymously), so the PR body links them — one click shows them
 * rendered on GitHub.
 */
export async function collectScreenshots(
  ssh: SandboxTarget,
  taskId: string,
): Promise<string[]> {
  const localDir = taskScreenshotDir(taskId);
  fs.mkdirSync(localDir, { recursive: true });

  const res = await fetchRemoteDir({
    host: ssh.host,
    container: ssh.container,
    user: ssh.user,
    privateKeyPath: ssh.privateKeyPath,
    remoteDir: REMOTE_SHOT_DIR,
    localDir,
    timeoutMs: 120_000,
  }).catch(() => null);
  // A missing remote dir just means the agent took none — not an error.
  if (!res || res.code !== 0) return [];

  return fs
    .readdirSync(localDir)
    .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
    .sort();
}

/**
 * Uploads the screenshots to the assets branch with the contents API — no
 * checkout, no working-tree juggling, so the task's branch is untouched.
 * Returns the repo's "owner/name", or null if the upload didn't happen.
 */
async function pushScreenshotsToAssetsBranch(
  ssh: SandboxTarget,
  taskId: string,
  onLog: (line: string) => void,
): Promise<string | null> {
  const script = `
set -e
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)

# Create the assets branch off the default branch the first time only.
if ! gh api "repos/$REPO/branches/${ASSETS_BRANCH}" >/dev/null 2>&1; then
  SHA=$(gh api "repos/$REPO/git/ref/heads/$DEFAULT" -q .object.sha)
  gh api --method POST "repos/$REPO/git/refs" -f ref='refs/heads/${ASSETS_BRANCH}' -f sha="$SHA" >/dev/null
fi

for f in ${REMOTE_SHOT_DIR}/*; do
  [ -f "$f" ] || continue
  NAME=$(basename "$f")
  PATH_IN_REPO="screenshots/${taskId}/$NAME"
  # Existing file needs its blob sha to be replaced.
  SHA=$(gh api "repos/$REPO/contents/$PATH_IN_REPO?ref=${ASSETS_BRANCH}" -q .sha 2>/dev/null || true)
  if [ -n "$SHA" ]; then
    gh api --method PUT "repos/$REPO/contents/$PATH_IN_REPO" \
      -f message="chore(nexux): screenshot $NAME" -f branch='${ASSETS_BRANCH}' \
      -f sha="$SHA" -f content="$(base64 -w0 "$f")" >/dev/null
  else
    gh api --method PUT "repos/$REPO/contents/$PATH_IN_REPO" \
      -f message="chore(nexux): screenshot $NAME" -f branch='${ASSETS_BRANCH}' \
      -f content="$(base64 -w0 "$f")" >/dev/null
  fi
done
echo "REPO:$REPO"
`.trim();

  const res = await execRemote(script, { ...ssh, timeoutMs: 180_000 }).catch(
    () => null,
  );
  const match = res?.stdout.match(/REPO:(\S+)/);
  if (!res || res.code !== 0 || !match) {
    onLog(
      `[nexux] WARN: could not publish screenshots to ${ASSETS_BRANCH}: ${(res?.stderr ?? "").trim().slice(-200)}`,
    );
    return null;
  }
  return match[1];
}

/**
 * Starts the app on the instance and exposes it through a Cloudflare quick
 * tunnel, so the PR can be reviewed live. Returns the public URL.
 *
 * The app and the tunnel are left running (the sandbox is ephemeral anyway);
 * a later task replaces them. The URL is unguessable but PUBLIC — anyone who
 * has it reaches the app, so this is opt-in per project.
 */
export async function startLivePreview(
  ssh: SandboxTarget,
  opts: { runCommand: string | null; port: number },
  onLog: (line: string) => void,
): Promise<string | null> {
  if (!opts.runCommand) {
    onLog(
      `[nexux] WARN: no run command configured for the repo — cannot start a live preview`,
    );
    return null;
  }

  const script = renderLivePreviewScript({
    cwd: ssh.cwd,
    runCommand: opts.runCommand,
    port: opts.port,
  });

  // Keep the SSH failure itself: swallowing it leaves the caller with an empty
  // log and no way to tell "app crashed" from "could not reach the sandbox".
  let res: Awaited<ReturnType<typeof execRemote>> | null = null;
  let sshError: string | null = null;
  try {
    res = await execRemote(script, { ...ssh, timeoutMs: 300_000 });
  } catch (err) {
    sshError = err instanceof Error ? err.message : String(err);
  }

  const match = res?.stdout.match(
    /PREVIEW:(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/,
  );
  if (match) return match[1];

  if (sshError) {
    onLog(
      `[nexux] WARN: could not run the preview command on the sandbox\n${sshError}`,
    );
    return null;
  }

  // The script already tails 25 lines of the relevant log; keep them all —
  // a stack trace is useless truncated to its last 8 lines.
  const out = (res?.stdout ?? "").trim();
  const err = (res?.stderr ?? "").trim();
  const tail = [out, err && `[stderr]\n${err}`].filter(Boolean).join("\n");
  const detail = tail || "(the sandbox produced no output)";

  if (out.includes("APP_FAILED")) {
    onLog(
      `[nexux] WARN: the app did not start on port ${opts.port} — no live preview\n` +
        `[nexux] run command: ${opts.runCommand}\n${detail}`,
    );
  } else if (out.includes("TUNNEL_FAILED")) {
    onLog(
      `[nexux] WARN: the app is up on port ${opts.port} but the cloudflare tunnel did not open\n${detail}`,
    );
  } else if (res && res.code !== 0) {
    // The 300s cap kills the transport with SIGKILL and still resolves, so a
    // non-zero code here usually means "the boot outran the timeout".
    onLog(
      `[nexux] WARN: the preview command exited ${res.code} (timed out after 300s, or the connection dropped)\n${detail}`,
    );
  } else {
    onLog(
      `[nexux] WARN: the preview script ended without a tunnel URL\n${detail}`,
    );
  }
  return null;
}

/** The PR/MR screenshot section: images embedded inline as <img> tags. */
export function renderScreenshotSection(
  links: Array<{ name: string; url: string }> | null,
  files: string[],
  gitlab: boolean,
): string {
  if (files.length === 0) return "";
  if (!links || links.length === 0) {
    return `\n\n## 📸 Screenshots\n\n${files.length} captured with agent-browser, but they could not be published for inline display — see the task log in Nexus.`;
  }
  const items = links.map(({ name, url }) => {
    const label = name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    return `**${label}**\n\n<img width="600" alt="${label}" src="${url}" />`;
  });
  const footer = gitlab
    ? `_Uploaded as project attachments, so the MR's diff stays code-only._`
    : `_Kept on the \`${ASSETS_BRANCH}\` branch, so this PR's diff stays code-only._`;
  return `\n\n## 📸 Screenshots\n\nThe running app, captured with agent-browser:\n\n${items.join("\n\n")}\n\n${footer}`;
}

export function createLogWriter(taskId: string) {
  let full = "";
  let timer: NodeJS.Timeout | null = null;
  let writing = Promise.resolve();

  const flush = () => {
    timer = null;
    const snapshot = full;
    writing = writing.then(() =>
      prisma.sandboxTask
        .update({ where: { id: taskId }, data: { log: snapshot } })
        .then(() => undefined)
        .catch(() => undefined),
    );
  };

  return {
    sink(chunk: string) {
      full += chunk;
      if (!timer) timer = setTimeout(flush, 1000);
    },
    append(line: string) {
      this.sink(line.endsWith("\n") ? line : line + "\n");
    },
    async close() {
      if (timer) clearTimeout(timer);
      flush();
      await writing;
    },
  };
}

export async function createTask(opts: {
  projectId: string;
  sandboxId: string;
  featureId?: string | null;
  prompt: string;
  /** Continue an earlier task: same branch, same PR, resumed Claude session. */
  followUpOf?: string | null;
  /** Promote this queued placeholder (launch-and-run) instead of creating. */
  existingTaskId?: string | null;
}): Promise<SandboxTask> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: opts.sandboxId, projectId: opts.projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");
  if (!sandboxReachable(sandbox)) {
    throw new Error("Sandbox is not running");
  }
  if (busySandboxes.has(sandbox.id)) {
    throw new Error("This sandbox is already running a task");
  }

  const parent = opts.followUpOf
    ? await prisma.sandboxTask.findFirst({
        where: { id: opts.followUpOf, sandbox: { projectId: opts.projectId } },
      })
    : null;
  if (opts.followUpOf && !parent) {
    throw new Error("Parent task not found");
  }
  if (parent && parent.sandboxId !== sandbox.id) {
    throw new Error(
      "Follow-ups must run on the same sandbox as the original task",
    );
  }
  if (parent && !parent.branch) {
    throw new Error("The original task has no branch to continue");
  }

  const [workDir, policy, skills, agents, runCommand, searchContext] =
    await Promise.all([
      resolveWorkDir(opts.projectId),
      loadPolicy(opts.projectId),
      loadSkills(opts.projectId),
      loadAgents(opts.projectId),
      resolveRunCommand(opts.projectId),
      // Follow-ups resume a session that already carries this context.
      parent ? null : buildSearchContext(opts.projectId, opts.prompt),
    ]);

  const featureId = opts.featureId ?? parent?.featureId ?? null;
  const feature = featureId
    ? await prisma.feature.findUnique({ where: { id: featureId } })
    : null;

  // A feature can pin whether its run opens a PR; null keeps the project
  // default. Follow-ups inherit it through the same featureId, so a chain of
  // tasks on one feature never changes its mind halfway.
  const effectivePolicy = withFeaturePrOverride(policy, feature?.createPr);

  // A follow-up continues the parent's branch (and therefore its PR).
  // `<type>/<slug>-<id>`, the way the rest of the repo names branches. A
  // follow-up keeps the parent's branch: renaming it mid-chain would orphan
  // the PR already open on it.
  const branch =
    parent?.branch ??
    branchName(
      feature?.title ?? opts.prompt,
      Date.now().toString(36).slice(-5),
    );

  // Feature attachments ride on the task (fresh tasks only — a follow-up's
  // session already inspected them).
  const attachments = parent
    ? []
    : ((feature?.attachments as TaskAttachment[] | null) ?? []);

  // launch-and-run pre-creates a queued placeholder task so the UI shows
  // progress during provisioning — promote it instead of creating a new row.
  const task = opts.existingTaskId
    ? await prisma.sandboxTask.update({
        where: { id: opts.existingTaskId },
        data: {
          workDir,
          branch,
          followUpOf: parent?.id ?? null,
          prUrl: parent?.prUrl ?? null,
          status: "running",
          phase: "agent",
          attachments: attachments.length ? attachments : undefined,
        },
      })
    : await prisma.sandboxTask.create({
        data: {
          sandboxId: sandbox.id,
          featureId,
          prompt: opts.prompt,
          workDir,
          branch,
          followUpOf: parent?.id ?? null,
          prUrl: parent?.prUrl ?? null,
          status: "running",
          phase: "agent",
          attachments: attachments.length ? attachments : undefined,
        },
      });

  // Feature moves to in_progress while the agent works on it.
  if (feature) {
    await prisma.feature
      .update({
        where: { id: feature.id },
        data: { status: "in_progress" },
      })
      .catch(() => undefined);
  }

  busySandboxes.add(sandbox.id);
  void runTask({
    taskId: task.id,
    target: sandboxTarget(sandbox, workDir),
    rootTarget: sandboxTarget(sandbox, workDir, "root"),
    attachments,
    workDir,
    branch,
    prompt: opts.prompt,
    policy: effectivePolicy,
    skills,
    agents,
    runCommand,
    searchContext,
    featureId,
    featureTitle: feature?.title ?? null,
    resumeSessionId: parent?.sessionId ?? null,
    existingPrUrl: parent?.prUrl ?? null,
  }).finally(() => busySandboxes.delete(sandbox.id));

  return task;
}

/**
 * A feature moved to done no longer needs its work sandboxes. Destroys every
 * sandbox that ran this feature's tasks, EXCEPT dev sandboxes (dedicated),
 * sandboxes with a task in flight, and sandboxes also serving another
 * feature that isn't done yet.
 */
export async function destroyFeatureSandboxes(featureId: string): Promise<void> {
  const tasks = await prisma.sandboxTask.findMany({
    where: { featureId },
    select: { sandboxId: true },
    distinct: ["sandboxId"],
  });
  for (const { sandboxId } of tasks) {
    const sandbox = await prisma.sandbox.findUnique({
      where: { id: sandboxId },
    });
    if (!sandbox || sandbox.dedicated) continue;
    if (!["pending", "provisioning", "running"].includes(sandbox.status)) {
      continue;
    }
    if (busySandboxes.has(sandboxId)) continue;
    const otherActive = await prisma.sandboxTask.findFirst({
      where: {
        sandboxId,
        featureId: { not: featureId },
        feature: { status: { not: "done" } },
      },
      select: { id: true },
    });
    if (otherActive) continue;
    const { requestDestroy } = await import("./sandbox-manager");
    await requestDestroy(sandboxId).catch((err) =>
      console.error("[nexux] feature-done sandbox cleanup failed:", err),
    );
  }
}

/**
 * M1 — Launch & Run: no running sandbox? Provision one and dispatch the task
 * automatically once the instance is up AND bootstrapped (repo cloned).
 * Returns as soon as the sandbox record exists; dispatch happens in the
 * background and shows up in the task list like any other task.
 */
export async function launchAndRunTask(opts: {
  projectId: string;
  featureId?: string | null;
  prompt: string;
  /** Override the project's configured provider (e.g. scheduled local runs). */
  provider?: "civo" | "aws" | "local";
  /** Destroy the sandbox automatically once the task settles. */
  ephemeral?: boolean;
}): Promise<{ sandboxId: string; taskId: string }> {
  // Dynamic import: keeps the module graph acyclic-ish (sandbox-manager pulls
  // telegram, which lazily pulls this module).
  const { launchSandbox } = await import("./sandbox-manager");
  const sandbox = await launchSandbox(opts.projectId, opts.provider);
  if (opts.ephemeral) {
    await prisma.sandbox
      .update({ where: { id: sandbox.id }, data: { ephemeral: true } })
      .catch(() => undefined);
  }

  // Visible from second zero: a queued placeholder task (promoted to running
  // at dispatch) and the feature parked in in_progress.
  const workDir = await resolveWorkDir(opts.projectId);
  const queued = await prisma.sandboxTask.create({
    data: {
      sandboxId: sandbox.id,
      featureId: opts.featureId ?? null,
      prompt: opts.prompt,
      workDir,
      status: "queued",
      phase: "provision",
    },
  });
  if (opts.featureId) {
    await prisma.feature
      .update({ where: { id: opts.featureId }, data: { status: "in_progress" } })
      .catch(() => undefined);
  }

  void superviseLaunch({
    projectId: opts.projectId,
    sandboxId: sandbox.id,
    taskId: queued.id,
    featureId: opts.featureId ?? null,
    prompt: opts.prompt,
    ephemeral: opts.ephemeral ?? false,
  });

  return { sandboxId: sandbox.id, taskId: queued.id };
}

/**
 * Waits for a launching sandbox to become ready and dispatches its queued
 * task. Everything it needs is persisted (task row + Sandbox.ephemeral), so
 * `recoverPendingLaunches` can resume supervision after a server restart —
 * without it, a restart orphaned queued tasks forever and left ephemeral
 * sandboxes running.
 */
async function superviseLaunch(opts: {
  projectId: string;
  sandboxId: string;
  taskId: string;
  featureId: string | null;
  prompt: string;
  ephemeral: boolean;
}): Promise<void> {
  // Provisioning died before dispatch → surface it on the task and put the
  // feature back where the user can retry it.
  const fail = async (message: string) => {
    console.error(`[launch-and-run] ${message}`);
    await prisma.sandboxTask
      .update({
        where: { id: opts.taskId },
        data: { status: "error", error: message, finishedAt: new Date() },
      })
      .catch(() => undefined);
    if (opts.featureId) {
      await prisma.feature
        .update({ where: { id: opts.featureId }, data: { status: "todo" } })
        .catch(() => undefined);
    }
    // An ephemeral sandbox that never got its task shouldn't keep billing.
    if (opts.ephemeral) {
      const { requestDestroy } = await import("./sandbox-manager");
      await requestDestroy(opts.sandboxId).catch(() => undefined);
    }
  };

  const deadline = Date.now() + 20 * 60_000;
  let phase = "provision";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15_000));
    const s = await prisma.sandbox.findUnique({
      where: { id: opts.sandboxId },
      select: {
        status: true,
        provider: true,
        publicIp: true,
        instanceId: true,
      },
    });
    if (!s || ["error", "destroyed", "destroying"].includes(s.status)) {
      await fail("Sandbox failed while provisioning — task not dispatched");
      return;
    }
    if (!sandboxReachable(s)) continue;
    if (phase === "provision") {
      // Running ≠ ready: cloud-init keeps cloning/installing after
      // terraform returns.
      phase = "bootstrap";
      await prisma.sandboxTask
        .update({ where: { id: opts.taskId }, data: { phase } })
        .catch(() => undefined);
    }
    // Wait for the bootstrap marker and the repo checkout.
    const health = await checkSandboxHealth(
      opts.projectId,
      opts.sandboxId,
    ).catch(() => null);
    if (!health?.bootstrapComplete || !health.repoPresent) continue;
    try {
      await createTask({
        projectId: opts.projectId,
        sandboxId: opts.sandboxId,
        featureId: opts.featureId,
        prompt: opts.prompt,
        existingTaskId: opts.taskId,
      });
    } catch (err) {
      await fail(
        `Task dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  await fail("Sandbox never became ready (20 min) — task not dispatched");
}

/**
 * Server-start sweep: re-attach supervision to queued launch-and-run tasks
 * whose in-memory supervisor died with the previous process. Sandboxes that
 * meanwhile failed or vanished get failed + torn down by the supervisor.
 */
export async function recoverPendingLaunches(): Promise<void> {
  const pending = await prisma.sandboxTask.findMany({
    where: { status: "queued", phase: { in: ["provision", "bootstrap"] } },
    include: {
      sandbox: {
        select: { id: true, projectId: true, ephemeral: true },
      },
    },
  });
  for (const task of pending) {
    console.log(
      `[tasks] recovering launch-and-run supervision for task ${task.id}`,
    );
    void superviseLaunch({
      projectId: task.sandbox.projectId,
      sandboxId: task.sandboxId,
      taskId: task.id,
      featureId: task.featureId,
      prompt: task.prompt,
      ephemeral: task.sandbox.ephemeral,
    });
  }
}

/**
 * Server-start sweep: fail pipeline tasks whose runner died with the previous
 * process.
 *
 * `runTask` is an in-process promise, so a task left `running` at boot has no
 * driver and never will — it stays `running` forever, keeps its feature in
 * `in_progress`, and cannot even be deleted, because DELETE refuses a running
 * task. The dev console has swept its own orphans since D-15
 * (`recoverDevQueues`); the PR pipeline never got the same treatment, which is
 * the whole difference between a crash costing one task and costing a row that
 * outlives every restart.
 *
 * Deliberately narrow: only `running`. Queued launch-and-run tasks are the
 * business of `recoverPendingLaunches`, which re-attaches rather than fails.
 *
 * The feature is left in `in_progress` on purpose — its previous column is not
 * recorded anywhere, and guessing `queued` would re-dispatch work the user
 * never asked to repeat.
 */
export async function recoverOrphanTasks(): Promise<void> {
  const orphaned = await prisma.sandboxTask.findMany({
    where: { status: "running", kind: { not: "dev" } },
    select: { id: true },
  });
  for (const task of orphaned) {
    console.log(`[tasks] failing orphaned task ${task.id} (no runner)`);
    await prisma.sandboxTask
      .update({
        where: { id: task.id },
        data: {
          status: "error",
          error: "Interrupted by a server restart — dispatch the feature again",
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
    void notifyTaskFinished(task.id).catch(() => undefined);
  }
}

async function runTask(opts: {
  taskId: string;
  target: SandboxTarget;
  rootTarget: SandboxTarget;
  attachments: TaskAttachment[];
  workDir: string;
  branch: string;
  prompt: string;
  policy: AgentPolicy;
  skills: SkillDef[];
  agents: AgentDef[];
  runCommand: string | null;
  searchContext?: string | null;
  featureId: string | null;
  featureTitle: string | null;
  resumeSessionId?: string | null;
  existingPrUrl?: string | null;
}) {
  const { taskId, branch, policy } = opts;
  const log = createLogWriter(taskId);
  // Everything in a task runs as the unprivileged agent user: it owns the
  // checkouts, and Claude Code needs a non-root user to bypass permissions.
  const ssh = {
    ...opts.target,
    onLog: log.sink.bind(log),
  };

  const fail = async (message: string) => {
    log.append(`[nexux] ERROR: ${message}`);
    await prisma.sandboxTask
      .update({
        where: { id: taskId },
        data: { status: "error", error: message, finishedAt: new Date() },
      })
      .catch(() => undefined);
    if (opts.featureId) {
      await prisma.feature
        .update({ where: { id: opts.featureId }, data: { status: "todo" } })
        .catch(() => undefined);
    }
    void notifyTaskFinished(taskId).catch(() => undefined);
  };

  const isFollowUp = Boolean(opts.resumeSessionId || opts.existingPrUrl);

  try {
    // Remote + host detection up front: bootstrap/mounted repos often have
    // no origin — they branch from local HEAD and keep commits local, and
    // the push/PR steps are skipped. GitHub vs GitLab picks the CLI later.
    const origin = await execRemote(
      `git remote get-url origin 2>/dev/null; echo "NEXUX_GLHOST:\${GITLAB_HOST:-}"`,
      { ...ssh, timeoutMs: 15_000 },
    );
    const originUrl = (
      origin.stdout
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("NEXUX_GLHOST:")) ?? ""
    ).trim();
    const hasRemote = originUrl !== "";
    const declaredGitLabHost = (
      origin.stdout.match(/NEXUX_GLHOST:(\S+)/)?.[1] ?? ""
    )
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    // Per-URL because the delivery sweep can surface sibling checkouts whose
    // origin lives on a different host than the workDir repo's.
    const gitLabUrl = (url: string) => {
      const host = gitUrlHost(url);
      return (
        /gitlab/i.test(host) ||
        (declaredGitLabHost !== "" && host === declaredGitLabHost)
      );
    };
    const isGitLab = gitLabUrl(originUrl);

    // 1. Branch: fresh for a new task, the parent's for a follow-up.
    log.append(
      isFollowUp
        ? `[nexux] continuing on branch ${branch}`
        : `[nexux] preparing branch ${branch}${hasRemote ? "" : " (no remote — local branch from HEAD)"}`,
    );
    // New task branches start from the configured base branch (or the clone's
    // HEAD when none is set). Without a remote there is nothing to fetch.
    const prep = await execRemote(
      isFollowUp
        ? `git checkout '${branch}'`
        : hasRemote
          ? `git fetch origin && git checkout -B '${branch}'${policy.baseBranch ? ` 'origin/${policy.baseBranch}'` : ""}`
          : `git checkout -B '${branch}'`,
      { ...ssh, timeoutMs: 120_000 },
    );
    if (prep.code !== 0) {
      return fail(
        `Could not check out ${branch}: ${prep.stderr.trim().slice(-300)}`,
      );
    }

    // Snapshot HEAD so "did the agent commit?" survives the agent pushing on
    // its own (which syncs the upstream ref and would zero an ahead-count).
    const headBefore = await execRemote(`git rev-parse HEAD`, {
      ...ssh,
      timeoutMs: 30_000,
    });
    const startHead = /^[0-9a-f]{40}$/.test(
      headBefore.stdout.trim().split("\n").pop() ?? "",
    )
      ? headBefore.stdout.trim().split("\n").pop()!
      : null;

    // 2a. Install the project's selected subagents and skills as native
    // ~/.claude context so the headless run can delegate to them and load
    // their full instructions (not just their names in the prompt).
    if (opts.agents.length > 0 || opts.skills.length > 0) {
      log.append(
        `[nexux] installing ${opts.agents.length} agent${opts.agents.length !== 1 ? "s" : ""} and ${opts.skills.length} skill${opts.skills.length !== 1 ? "s" : ""} into ~/.claude`,
      );
    }
    await materializeContext(ssh, { agents: opts.agents, skills: opts.skills });

    // Feature attachments (designs, docs) land next to the checkout so the
    // agent can Read them; the prompt lists their remote paths below.
    const remoteAttachments = await pushAttachments({
      target: ssh,
      rootTarget: opts.rootTarget,
      taskId,
      attachments: opts.attachments,
      log: log.append.bind(log),
    });

    // 2b. The agent: implement + test + self-review + commit.
    log.append(
      `[nexux] running Claude Code${opts.searchContext ? " — semantic project context attached" : ""}`,
    );
    const agentPrompt = isFollowUp
      ? buildFollowUpPrompt({
          task: opts.prompt,
          branch,
          policy,
          resumed: Boolean(opts.resumeSessionId),
        })
      : buildAgentPrompt({
          task: opts.prompt,
          branch,
          policy,
          skills: opts.skills,
          agents: opts.agents,
          runCommand: opts.runCommand,
          searchContext: opts.searchContext,
        });
    const attachmentsSection = renderAttachmentsSection(remoteAttachments);
    const finalPrompt = attachmentsSection
      ? `${agentPrompt}\n\n${attachmentsSection}`
      : agentPrompt;
    const res = await runAgentTask(policy.brain, finalPrompt, {
      ...ssh,
      timeoutMs: policy.taskTimeoutMinutes * 60_000,
      resumeSessionId: opts.resumeSessionId ?? undefined,
      model: policyModel(policy),
    });
    if (!res.ok) {
      return fail(res.error ?? "Agent run failed");
    }
    if (res.sessionId) {
      await prisma.sandboxTask
        .update({
          where: { id: taskId },
          data: { sessionId: res.sessionId },
        })
        .catch(() => undefined);
    }

    // Screenshots live outside the checkout, so the PR diff stays code-only.
    // They go to Nexus (local record) and to the assets branch (so the PR can
    // link them inside the private repo).
    let shots: string[] = [];
    let shotLinks: Array<{ name: string; url: string }> | null = null;
    if (policy.captureScreenshots) {
      shots = await collectScreenshots(ssh, taskId);
      log.append(
        shots.length
          ? `[nexux] collected ${shots.length} screenshot${shots.length !== 1 ? "s" : ""}`
          : `[nexux] WARN: the agent produced no screenshots`,
      );
      if (shots.length > 0 && policy.createPr && !hasRemote) {
        log.append(
          `[nexux] screenshots stay local — this repo has no remote to publish to`,
        );
      } else if (shots.length > 0 && policy.createPr && isGitLab) {
        // GitLab: the project uploads API — its files render inline in MR
        // descriptions for anyone with project access, no branch needed.
        const repo = parseGitRemote(originUrl);
        const up = repo
          ? await execRemote(gitlabUploadShotsCommand(repo), {
              ...ssh,
              timeoutMs: 180_000,
            }).catch(() => null)
          : null;
        shotLinks = repo && up ? parseShotUploads(up.stdout, repo) : null;
        if (shotLinks?.length) {
          log.append(
            `[nexux] ${shotLinks.length} screenshot${shotLinks.length !== 1 ? "s" : ""} uploaded to GitLab`,
          );
        } else {
          shotLinks = null;
          log.append(
            `[nexux] WARN: could not upload screenshots to GitLab: ${(
              up?.stdout.match(/NEXUX_SHOT_ERR\|(.+)/)?.[1] ??
              up?.stderr ??
              "no upload response"
            )
              .trim()
              .slice(-200)}`,
          );
        }
      } else if (shots.length > 0 && policy.createPr) {
        const assetsRepo = await pushScreenshotsToAssetsBranch(
          ssh,
          taskId,
          log.append.bind(log),
        );
        if (assetsRepo) {
          log.append(`[nexux] screenshots published to ${ASSETS_BRANCH}`);
          shotLinks = shots.map((name) => ({
            name,
            // The /raw/ same-repo URL renders inline even on private repos:
            // GitHub rewrites it to a signed raw URL for viewers with access.
            url: `https://github.com/${assetsRepo}/raw/${ASSETS_BRANCH}/screenshots/${taskId}/${encodeURIComponent(name)}`,
          }));
        }
      }
    }
    const shotsNote = renderScreenshotSection(shotLinks, shots, isGitLab);

    // Live preview: run the app on the instance behind a public quick tunnel
    // so the PR can be clicked through instead of only read.
    let previewUrl: string | null = null;
    if (policy.livePreview) {
      log.append(`[nexux] starting live preview`);
      previewUrl = await startLivePreview(
        ssh,
        { runCommand: opts.runCommand, port: policy.previewPort },
        log.append.bind(log),
      );
      if (previewUrl) {
        log.append(`[nexux] live preview: ${previewUrl}`);
        await prisma.sandboxTask
          .update({ where: { id: taskId }, data: { previewUrl } })
          .catch(() => undefined);
      }
    }
    const previewNote = previewUrl
      ? `\n\n## 🔗 Live preview\n\n${previewUrl}\n\n_Running on the Nexus sandbox behind a Cloudflare quick tunnel. It dies with the sandbox — and while it lives, anyone with the link can reach it._`
      : "";

    // 3. Did it actually commit anything? Compare against the pre-agent HEAD
    // when we have it — ahead-of-upstream counts lie if the agent pushed.
    const diff = await execRemote(
      startHead
        ? `git rev-list --count '${startHead}..HEAD'`
        : isFollowUp
          ? `git rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0`
          : `git rev-list --count origin/HEAD..HEAD 2>/dev/null || git rev-list --count HEAD --not --remotes`,
      { ...ssh, timeoutMs: 60_000 },
    );
    const commits = parseInt(diff.stdout.trim().split("\n").pop() || "0", 10);

    // Where does the deliverable work actually sit? Sweep every checkout in
    // the workspace for this branch with commits no remote has: the agent may
    // have (correctly) implemented the task in a sibling repo, or an earlier
    // run may have left the branch committed but undelivered. Counting only
    // workDir made both look like "the agent did nothing" and skipped
    // delivery entirely.
    const samePath = (a: string, b: string) =>
      a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
    let targets: DeliveryTarget[] = [];
    if (policy.createPr) {
      const sweep = await execRemote(deliverySweepCommand(branch), {
        ...ssh,
        timeoutMs: 60_000,
      }).catch(() => null);
      targets = sweep ? parseDeliverySweep(sweep.stdout) : [];
      // Deliver from the task's own checkout first.
      targets.sort(
        (a, b) =>
          Number(samePath(b.dir, opts.workDir)) -
          Number(samePath(a.dir, opts.workDir)),
      );
      // workDir belongs in the list even with nothing unpushed: the agent may
      // have pushed on its own, leaving the PR itself still owed.
      if (
        commits > 0 &&
        hasRemote &&
        !targets.some((t) => samePath(t.dir, opts.workDir))
      ) {
        targets.unshift({ dir: opts.workDir, unpushed: commits, originUrl });
      }
    }

    if (!commits && targets.length === 0) {
      await prisma.sandboxTask.update({
        where: { id: taskId },
        data: {
          status: "completed",
          phase: null,
          prUrl: opts.existingPrUrl ?? null,
          result: res.result ?? null,
          costUsd: res.costUsd ?? null,
          durationMs: res.durationMs ?? null,
          error: isFollowUp
            ? "The agent made no new commits — the PR is unchanged."
            : "The agent made no commits — nothing to open a PR with.",
          finishedAt: new Date(),
        },
      });
      if (opts.featureId && !isFollowUp) {
        await prisma.feature
          .update({ where: { id: opts.featureId }, data: { status: "todo" } })
          .catch(() => undefined);
      }
      return;
    }

    let prUrl: string | null = opts.existingPrUrl ?? null;
    const extraPrUrls: string[] = [];

    if (policy.createPr && targets.length === 0) {
      // Bootstrap/mounted repos without a remote: the work is committed on
      // the task branch in the (mounted) checkout — the user merges locally.
      log.append(
        `[nexux] no remote configured — commits stay on branch '${branch}' in the checkout; add a repo URL to enable push + PR`,
      );
    }

    if (policy.createPr && targets.length > 0) {
      await prisma.sandboxTask.update({
        where: { id: taskId },
        data: { phase: "pr" },
      });

      for (const t of targets) {
        const tSsh = { ...ssh, cwd: t.dir };
        const tGitLab = gitLabUrl(t.originUrl);
        const sibling = !samePath(t.dir, opts.workDir);
        if (sibling) {
          log.append(
            `[nexux] undelivered work found in sibling checkout ${t.dir} (${t.unpushed} commit${t.unpushed !== 1 ? "s" : ""} on ${branch})`,
          );
        }
        // An existing PR only absorbs pushes to its own repo; any other
        // checkout with work on this branch still needs its PR opened.
        const updatesExisting = Boolean(
          prUrl && prUrlMatchesRepo(prUrl, t.originUrl),
        );

        // 4. Push. On a repo whose PR exists this updates it automatically.
        log.append(
          updatesExisting
            ? `[nexux] pushing ${branch} — the PR updates itself`
            : `[nexux] pushing ${branch} and opening ${tGitLab ? "MR" : "PR"}${sibling ? ` in ${t.dir}` : ""}`,
        );
        const push = await execRemote(`git push -u origin '${branch}'`, {
          ...tSsh,
          timeoutMs: 180_000,
        });
        if (push.code !== 0) {
          return fail(
            `git push failed${sibling ? ` in ${t.dir}` : ""}: ${push.stderr.trim().slice(-300)}`,
          );
        }

        if (!updatesExisting) {
          // Classified, not assumed: a hardcoded `feat:` turned a tracker's
          // "Bug: …" into "feat: Bug: …", which is wrong twice over. Falls back
          // to the prompt so a promptless run still gets a conventional title
          // rather than one announcing the tool.
          const title = conventionalTitle(
            opts.featureTitle ?? opts.prompt.slice(0, 72),
          );
          // Claude's report becomes the PR body; a file avoids quoting issues.
          const body = (res.result ?? "Automated implementation for this task.")
            .concat(shotsNote)
            .concat(previewNote);
          const bodyFile = `/tmp/nexux-pr-${taskId}.md`;
          const writeBody = await execRemote(
            `cat > ${bodyFile} <<'NEXUX_PR_EOF'\n${body}\nNEXUX_PR_EOF`,
            { ...tSsh, timeoutMs: 30_000 },
          );
          if (writeBody.code !== 0) {
            return fail("Could not stage the PR body on the instance");
          }

          const safeTitle = title.replace(/'/g, "");
          const createCmd = tGitLab
            ? `glab mr create --title '${safeTitle}' --description "$(cat ${bodyFile})" --source-branch '${branch}'${policy.baseBranch ? ` --target-branch '${policy.baseBranch}'` : ""} --yes`
            : `gh pr create --title '${safeTitle}' --body-file ${bodyFile} --head '${branch}'${policy.baseBranch ? ` --base '${policy.baseBranch}'` : ""}`;
          const pr = await execRemote(createCmd, { ...tSsh, timeoutMs: 120_000 });
          const match = (pr.stdout + pr.stderr).match(
            tGitLab
              ? /https:\/\/\S+\/-\/merge_requests\/\d+/
              : /https:\/\/github\.com\/\S+\/pull\/\d+/,
          );
          if (pr.code !== 0 || !match) {
            return fail(
              `${tGitLab ? "glab mr" : "gh pr"} create failed: ${(pr.stderr || pr.stdout).trim().slice(-300)}`,
            );
          }
          if (prUrl) extraPrUrls.push(match[0]);
          else prUrl = match[0];
          log.append(`[nexux] ${tGitLab ? "MR" : "PR"} opened: ${match[0]}`);
        } else {
          // Leave a trace of the follow-up on the PR/MR itself.
          const noteFile = `/tmp/nexux-followup-${taskId}.md`;
          const note = (res.result ?? "Follow-up applied.")
            .concat(shotsNote)
            .concat(previewNote);
          const commentCmd = tGitLab
            ? `glab mr note '${branch}' -m "$(cat ${noteFile})"`
            : `gh pr comment '${branch}' --body-file ${noteFile}`;
          await execRemote(
            `cat > ${noteFile} <<'NEXUX_NOTE_EOF'\n${note}\nNEXUX_NOTE_EOF\n${commentCmd}`,
            { ...tSsh, timeoutMs: 60_000 },
          ).catch(() => undefined);
          log.append(`[nexux] ${tGitLab ? "MR" : "PR"} updated: ${prUrl}`);
        }
      }
    }

    await prisma.sandboxTask.update({
      where: { id: taskId },
      data: {
        status: "completed",
        phase: null,
        prUrl,
        // The task row holds one prUrl; work delivered to further repos is
        // only reachable through the report, so surface it there.
        result:
          extraPrUrls.length > 0
            ? `${res.result ?? ""}\n\n_Nexux also opened: ${extraPrUrls.join(" · ")}_`.trim()
            : (res.result ?? null),
        costUsd: res.costUsd ?? null,
        durationMs: res.durationMs ?? null,
        finishedAt: new Date(),
      },
    });

    // Feature goes to review once there's a PR to look at.
    if (opts.featureId) {
      await prisma.feature
        .update({
          where: { id: opts.featureId },
          data: { status: prUrl ? "in_review" : "todo" },
        })
        .catch(() => undefined);
    }
    void notifyTaskFinished(taskId).catch(() => undefined);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  } finally {
    await log.close();
    await destroyIfEphemeral(taskId);
  }
}

/**
 * Ephemeral cycle (scheduled/one-shot runs): the sandbox exists only for its
 * task — once the task settles (PR opened or error), tear the sandbox down so
 * cloud instances stop billing and local containers free their RAM.
 */
async function destroyIfEphemeral(taskId: string): Promise<void> {
  try {
    const task = await prisma.sandboxTask.findUnique({
      where: { id: taskId },
      select: { sandboxId: true, sandbox: { select: { ephemeral: true, status: true } } },
    });
    if (!task?.sandbox.ephemeral) return;
    if (!["running", "error"].includes(task.sandbox.status)) return;
    console.log(`[tasks] ephemeral sandbox teardown after task ${taskId}`);
    const { requestDestroy } = await import("./sandbox-manager");
    await requestDestroy(task.sandboxId);
  } catch (err) {
    console.error("[tasks] ephemeral teardown failed:", err);
  }
}

/**
 * Start (or restart) the live preview for a sandbox, independently of a task —
 * "show me the app running on this instance, now". Persists the URL on the
 * sandbox so the UI can link to it.
 */
export async function startSandboxPreview(
  projectId: string,
  sandboxId: string,
): Promise<{ previewUrl: string | null; log: string }> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");
  if (!sandboxReachable(sandbox)) {
    throw new Error("Sandbox is not running");
  }

  const [workDir, policy, runCommand] = await Promise.all([
    resolveWorkDir(projectId),
    loadPolicy(projectId),
    resolveRunCommand(projectId),
  ]);
  if (!runCommand) {
    throw new Error(
      "No run command configured for the repository — set it in Sandbox settings → Repositories.",
    );
  }

  const lines: string[] = [];
  const previewUrl = await startLivePreview(
    sandboxTarget(sandbox, workDir),
    { runCommand, port: policy.previewPort },
    (line) => lines.push(line),
  );

  await prisma.sandbox
    .update({ where: { id: sandboxId }, data: { previewUrl } })
    .catch(() => undefined);

  return { previewUrl, log: lines.join("\n") };
}

/** Tear the preview down (app + tunnel) and forget its URL. */
export async function stopSandboxPreview(
  projectId: string,
  sandboxId: string,
): Promise<void> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");

  if (sandboxReachable(sandbox)) {
    await execRemote(
      // By PID, not pattern — see startLivePreview.
      `for f in ${PREVIEW_APP_PID} ${PREVIEW_TUNNEL_PID}; do [ -f "$f" ] && { kill -TERM -"$(cat "$f")" 2>/dev/null || kill -TERM "$(cat "$f")" 2>/dev/null; rm -f "$f"; }; done; true`,
      { ...sandboxTarget(sandbox, "/opt/nexus"), timeoutMs: 30_000 },
    ).catch(() => undefined);
  }

  await prisma.sandbox
    .update({ where: { id: sandboxId }, data: { previewUrl: null } })
    .catch(() => undefined);
}

/**
 * Host of a git remote URL. Tolerates embedded credentials (insteadOf
 * rewrites surface as https://oauth2:TOKEN@host/...) and scp-style syntax.
 */
function gitUrlHost(url: string): string {
  const trimmed = url.trim().replace(/^[a-z+]+:\/\//i, "");
  const authority = trimmed.split("/")[0] ?? "";
  const host = authority.split("@").pop() ?? "";
  return host.split(":")[0];
}

export type SandboxHealth = {
  reachable: boolean;
  bootstrapComplete: boolean;
  repoPresent: boolean;
  claudeReady: boolean;
  /** The git CLI matching the repo's host (gh or glab) is installed + authenticated. */
  gitReady: boolean;
  /** Which CLI the repo host needs: "glab" for GitLab origins, else "gh". */
  gitCli: "gh" | "glab";
  gitStatus: string;
  /** Tailnet address, when the sandbox joined one (installTailscale). */
  tailscaleIp?: string | null;
  error?: string;
};

/** Remote check: is the instance actually ready to take work? */
export async function checkSandboxHealth(
  projectId: string,
  sandboxId: string,
): Promise<SandboxHealth> {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");

  const base: SandboxHealth = {
    reachable: false,
    bootstrapComplete: false,
    repoPresent: false,
    claudeReady: false,
    gitReady: false,
    gitCli: "gh",
    gitStatus: "",
  };
  if (!sandboxReachable(sandbox)) {
    return { ...base, error: "Sandbox is not running" };
  }

  const workDir = await resolveWorkDir(projectId);

  const script = [
    `echo "BOOTSTRAP:$([ -f /opt/nexus/.bootstrap-complete ] && echo yes || echo no)"`,
    `echo "REPO:$([ -d '${workDir}/.git' ] && echo yes || echo no)"`,
    `echo "CLAUDE:$(command -v claude >/dev/null && [ -n "\${CLAUDE_CODE_OAUTH_TOKEN:-}\${ANTHROPIC_API_KEY:-}" ] && echo yes || echo no)"`,
    `echo "GH:$(command -v gh >/dev/null && [ -n "\${GITHUB_TOKEN:-}" ] && echo yes || echo no)"`,
    `echo "GLAB:$(command -v glab >/dev/null && [ -n "\${GITLAB_TOKEN:-}" ] && echo yes || echo no)"`,
    `echo "ORIGIN:$(git -C '${workDir}' remote get-url origin 2>/dev/null || true)"`,
    `echo "GLHOST:\${GITLAB_HOST:-}"`,
    `echo "TSIP:$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -1 || true)"`,
    `echo "GITSTATUS_START"`,
    `git -C '${workDir}' status --short 2>/dev/null | head -20`,
  ].join("; ");

  try {
    // Probe as the agent user — its view is what actually matters for tasks.
    const res = await execRemote(script, {
      ...sandboxTarget(sandbox, "/opt/nexus"),
      timeoutMs: 30_000,
    });
    if (res.code !== 0 && !res.stdout) {
      return { ...base, error: res.stderr.trim() || "SSH command failed" };
    }
    const out = res.stdout;
    const [, gitStatus = ""] = out.split("GITSTATUS_START\n");
    // The repo host decides which git CLI must be healthy: a GitLab origin
    // (gitlab.com, "gitlab" in the host, or the declared GITLAB_HOST) is
    // judged on glab+GITLAB_TOKEN, everything else on gh+GITHUB_TOKEN.
    const originHost = gitUrlHost(out.match(/^ORIGIN:(\S+)/m)?.[1] ?? "");
    const declaredGlHost = (out.match(/^GLHOST:(\S+)/m)?.[1] ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    const isGitLab =
      /gitlab/i.test(originHost) ||
      (declaredGlHost !== "" && originHost === declaredGlHost);
    // Tailnet address, straight from the instance. Persisted so the sandbox
    // row can show it without an SSH round-trip; only ever overwritten by a
    // new non-empty value — a probe that catches tailscaled mid-restart must
    // not blank an address that is still valid.
    const tailscaleIp = out.match(/^TSIP:(\S+)/m)?.[1]?.trim() || null;
    if (tailscaleIp && tailscaleIp !== sandbox.tailscaleIp) {
      await prisma.sandbox
        .update({ where: { id: sandbox.id }, data: { tailscaleIp } })
        .catch(() => undefined);
    }
    return {
      reachable: true,
      bootstrapComplete: /BOOTSTRAP:yes/.test(out),
      repoPresent: /REPO:yes/.test(out),
      claudeReady: /CLAUDE:yes/.test(out),
      gitReady: isGitLab ? /GLAB:yes/.test(out) : /GH:yes/.test(out),
      gitCli: isGitLab ? "glab" : "gh",
      gitStatus: gitStatus.trim(),
      tailscaleIp: tailscaleIp ?? sandbox.tailscaleIp,
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : "SSH failed",
    };
  }
}
