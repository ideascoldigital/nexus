// Start / stop / inspect the long-running processes on a sandbox.
//
// The old model was one "live preview" per sandbox: one run command (the main
// repo's), one port, one pair of PID files. A project with a web app *and* a
// functions emulator could only ever boot one of them, and the second start
// killed the first. This is the same design the host-side stackRunner already
// uses — one supervised process per startable command, addressed by a stable
// key — but reaching into the sandbox over exec instead of spawning locally.
//
// Every kill is by recorded PID, never by pattern: the script's own command
// line contains the command it is about to launch, so a `pkill -f` would match
// (and kill) the shell running it.

import { prisma, type SandboxProcess } from "@nexux/db";
import { execRemote } from "@nexux/sandbox";

import { sandboxReachable, sandboxTarget } from "@/lib/agent-core";
import {
  getSandboxProcessPlans,
  type SandboxProcessPlan,
} from "@/lib/stack/sandbox-processes";

/** Remote PID/log paths. Per key, so processes never clobber each other. */
const remoteSlug = (key: string) => key.replace(/[^a-zA-Z0-9_-]/g, "-");
export const procPidPath = (key: string) => `/tmp/nexus-proc-${remoteSlug(key)}.pid`;
export const procLogPath = (key: string) => `/tmp/nexus-proc-${remoteSlug(key)}.log`;
const procScriptPath = (key: string) => `/tmp/nexus-proc-${remoteSlug(key)}.sh`;
const procTunnelPidPath = (key: string) =>
  `/tmp/nexus-proc-${remoteSlug(key)}-tunnel.pid`;
const procTunnelLogPath = (key: string) =>
  `/tmp/nexus-proc-${remoteSlug(key)}-tunnel.log`;

/**
 * The pre-rename `/tmp/nexux-proc-*` paths.
 *
 * A sandbox that was already running when the host upgraded still has live
 * processes recorded under the old names. Reads (liveness, stop, logs) check
 * both so those stay visible and killable; writes only ever use the new path,
 * so the legacy set drains as processes are restarted.
 */
const legacyProcPidPath = (key: string) => `/tmp/nexux-proc-${remoteSlug(key)}.pid`;
const legacyProcLogPath = (key: string) => `/tmp/nexux-proc-${remoteSlug(key)}.log`;
const legacyProcTunnelPidPath = (key: string) =>
  `/tmp/nexux-proc-${remoteSlug(key)}-tunnel.pid`;

/** A process as the UI sees it: the plan, plus whatever is running now. */
export type SandboxProcessView = SandboxProcessPlan & {
  id: string | null;
  status: string;
  pid: number | null;
  previewUrl: string | null;
  error: string | null;
  startedAt: string | null;
  /** The plan changed since this was started (canvas edited mid-run). */
  stale: boolean;
};

/** The row fields liveness reconciliation reads — a structural subset of the
 *  Prisma row, so the rule can be exercised without a database. */
export type ProcessRowState = Pick<
  SandboxProcess,
  "key" | "status" | "role" | "pid" | "previewUrl"
>;

/**
 * The rows whose recorded PID can answer "is it still up".
 *
 * A launcher (`services`) is excluded: its shell exits by design once its
 * containers are detached — `make up` ending is success, not death — so its
 * recorded PID being gone says nothing about the services it brought up.
 */
export function pidProbeCandidates<T extends Pick<SandboxProcess, "status" | "role">>(
  rows: T[],
): T[] {
  return rows.filter(
    (r) =>
      (r.status === "running" || r.status === "starting") && r.role !== "services",
  );
}

/**
 * What the UI should show for one row given the probe's answer, and whether
 * the stored row must be flipped to stopped.
 *
 * `alive` is null when the box could not be asked — "cannot ask" is not the
 * same as "not running", so the stored answer stands.
 */
export function reconcileRowState(
  row: ProcessRowState | undefined,
  alive: Set<string> | null,
): { status: string; pid: number | null; previewUrl: string | null; flip: boolean } {
  const kept = {
    status: row?.status ?? "stopped",
    pid: row?.pid ?? null,
    previewUrl: row?.previewUrl ?? null,
    flip: false,
  };
  if (!alive || !row) return kept;
  if (row.status !== "running" && row.status !== "starting") return kept;
  // A launcher's containers outlive its PID; only its stop phase (or a sandbox
  // stop) ends it, so a dead launcher shell must not read as "stopped".
  if (row.role === "services") return kept;
  if (alive.has(row.key)) return kept;
  return { status: "stopped", pid: null, previewUrl: null, flip: true };
}

async function loadSandbox(projectId: string, sandboxId: string) {
  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) throw new Error("Sandbox not found");
  return sandbox;
}

/** Shell-quote for single-quoted contexts. */
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The stored rows for a sandbox, keyed. Rows survive a canvas edit so a
 * process started from an older plan can still be stopped by its PID.
 */
async function rowsByKey(sandboxId: string): Promise<Map<string, SandboxProcess>> {
  const rows = await prisma.sandboxProcess.findMany({ where: { sandboxId } });
  return new Map(rows.map((r) => [r.key, r]));
}

/**
 * Every process this sandbox can run, merged with live state.
 *
 * State is reconciled against the box on every read: a dev server that crashed,
 * or a container restart that took every PID with it, must not keep showing as
 * running. Unreachable sandboxes report the stored state untouched — "cannot
 * ask" is not the same as "not running".
 */
export async function listSandboxProcesses(
  projectId: string,
  sandboxId: string,
): Promise<SandboxProcessView[]> {
  const sandbox = await loadSandbox(projectId, sandboxId);
  const [plans, rows] = await Promise.all([
    getSandboxProcessPlans(projectId),
    rowsByKey(sandboxId),
  ]);

  const alive = sandboxReachable(sandbox)
    ? await probeAlive(sandbox, [...rows.values()])
    : null;

  const views: SandboxProcessView[] = [];
  for (const plan of plans) {
    const row = rows.get(plan.key);
    const { status, pid, previewUrl, flip } = reconcileRowState(row, alive);
    if (row && flip) {
      await prisma.sandboxProcess
        .update({
          where: { id: row.id },
          data: { status: "stopped", pid: null, previewUrl: null },
        })
        .catch(() => undefined);
    }
    views.push({
      ...plan,
      id: row?.id ?? null,
      status,
      pid,
      previewUrl,
      error: row?.error ?? null,
      startedAt: row?.startedAt?.toISOString() ?? null,
      // A command edited on the canvas while the process runs means what is up
      // is not what the row says — worth flagging rather than silently drifting.
      stale: Boolean(row && status === "running" && row.command !== plan.command),
    });
  }
  return views;
}

/** Which recorded PIDs are still alive on the box, by key. */
async function probeAlive(
  sandbox: Parameters<typeof sandboxTarget>[0],
  rows: SandboxProcess[],
): Promise<Set<string> | null> {
  const candidates = pidProbeCandidates(rows);
  if (!candidates.length) return new Set();
  // Either path counts as alive: a process started before the rename is still
  // running, and reporting it stopped would orphan it (the UI hides stop for
  // anything it believes is already dead).
  const checks = candidates
    .map(
      (r) =>
        `for f in ${procPidPath(r.key)} ${legacyProcPidPath(r.key)}; do if [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null; then echo "ALIVE:${r.key}"; break; fi; done`,
    )
    .join("\n");
  const res = await execRemote(checks, {
    ...sandboxTarget(sandbox, "/opt/nexus"),
    timeoutMs: 30_000,
  }).catch(() => null);
  if (!res) return null;
  const alive = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const key = line.trim().match(/^ALIVE:(.+)$/)?.[1];
    if (key) alive.add(key);
  }
  return alive;
}

/**
 * Boot one process and, when it serves a port, expose it through a Cloudflare
 * quick tunnel. Restarting is the same call — the previous PID for this key is
 * killed first, and only that one.
 *
 * The tunnel URL is unguessable but PUBLIC, so it is only opened for processes
 * that declare a port.
 */
export async function startSandboxProcess(
  projectId: string,
  sandboxId: string,
  key: string,
  opts: { tunnel?: boolean } = {},
): Promise<{ process: SandboxProcessView; log: string }> {
  const sandbox = await loadSandbox(projectId, sandboxId);
  if (!sandboxReachable(sandbox)) throw new Error("Sandbox is not running");

  const plans = await getSandboxProcessPlans(projectId);
  const plan = plans.find((p) => p.key === key);
  if (!plan) {
    throw new Error(
      "That process is no longer on the stack — reload the sandbox list.",
    );
  }

  const row = await prisma.sandboxProcess.upsert({
    where: { sandboxId_key: { sandboxId, key } },
    create: {
      sandboxId,
      key,
      label: plan.label,
      repositoryId: plan.repositoryId,
      command: plan.command,
      cwd: plan.cwd,
      port: plan.port,
      role: plan.role,
      status: "starting",
    },
    update: {
      label: plan.label,
      repositoryId: plan.repositoryId,
      command: plan.command,
      cwd: plan.cwd,
      port: plan.port,
      role: plan.role,
      status: "starting",
      error: null,
      previewUrl: null,
    },
  });

  const wantTunnel = opts.tunnel !== false && plan.port !== null;
  // The command goes into a script file via a quoted heredoc: inlining it would
  // have to survive three levels of shell quoting (this template, execRemote's
  // `bash -lc`, and ssh's own) and silently mangles.
  const script = `
set -u
${killBlock(key)}
sleep 1

mkdir -p ${plan.cwd} 2>/dev/null || true
cat > ${procScriptPath(key)} <<'NEXUX_RUN_EOF'
#!/bin/bash
[ -f /etc/profile.d/nexus-env.sh ] && . /etc/profile.d/nexus-env.sh
cd ${plan.cwd}
exec ${plan.command}
NEXUX_RUN_EOF
chmod +x ${procScriptPath(key)}

: > ${procLogPath(key)}
setsid ${procScriptPath(key)} > ${procLogPath(key)} 2>&1 < /dev/null &
PID=$!
echo $PID > ${procPidPath(key)}
echo "PID:$PID"
${
  plan.port === null
    ? // A launcher exits once its work is queued; there is no port to wait on,
      // so the only failure signal is the process dying immediately.
      `sleep 3
if kill -0 "$PID" 2>/dev/null; then echo "STARTED"; else echo "DETACHED"; fi
tail -n 25 ${procLogPath(key)}`
    : `# Wait for the port to answer before calling it up (a cold build is slow).
for i in $(seq 1 90); do
  curl -fs -o /dev/null "http://localhost:${plan.port}" 2>/dev/null && break
  sleep 2
done
if ! curl -fs -o /dev/null "http://localhost:${plan.port}" 2>/dev/null; then
  echo "APP_FAILED"
  tail -n 25 ${procLogPath(key)}
  exit 0
fi
echo "STARTED"
${
  wantTunnel
    ? `setsid cloudflared tunnel --no-autoupdate --url "http://localhost:${plan.port}" \\
  > ${procTunnelLogPath(key)} 2>&1 < /dev/null &
echo $! > ${procTunnelPidPath(key)}
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' ${procTunnelLogPath(key)} | head -1)
  [ -n "$URL" ] && { echo "PREVIEW:$URL"; exit 0; }
  sleep 2
done
echo "TUNNEL_FAILED"
tail -n 25 ${procTunnelLogPath(key)}`
    : ""
}`
}
`.trim();

  // Keep the transport failure itself: swallowing it leaves the caller with an
  // empty log and no way to tell "the app crashed" from "the box is gone".
  let res: Awaited<ReturnType<typeof execRemote>> | null = null;
  let sshError: string | null = null;
  try {
    res = await execRemote(script, {
      ...sandboxTarget(sandbox, plan.cwd),
      timeoutMs: 300_000,
    });
  } catch (err) {
    sshError = err instanceof Error ? err.message : String(err);
  }

  const out = (res?.stdout ?? "").trim();
  const stderr = (res?.stderr ?? "").trim();
  const log = [out, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n");
  const pid = Number(out.match(/PID:(\d+)/)?.[1]) || null;
  const previewUrl =
    out.match(/PREVIEW:(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/)?.[1] ?? null;

  let status: string;
  let error: string | null = null;
  if (sshError) {
    status = "error";
    error = `Could not reach the sandbox: ${sshError}`;
  } else if (out.includes("APP_FAILED")) {
    status = "error";
    error = `"${plan.command}" did not answer on port ${plan.port}. Check the log.`;
  } else if (out.includes("STARTED") || out.includes("DETACHED")) {
    status = "running";
    // A tunnel failing does not stop the app — it is up, just not public.
    if (out.includes("TUNNEL_FAILED")) {
      error = "The app is up, but the Cloudflare tunnel did not open.";
    }
  } else if (res && res.code !== 0) {
    status = "error";
    error = `The start script exited ${res.code} (timed out after 300s, or the connection dropped).`;
  } else {
    status = "error";
    error = "The start script ended without reporting the process up.";
  }

  const updated = await prisma.sandboxProcess.update({
    where: { id: row.id },
    data: {
      status,
      pid: status === "running" ? pid : null,
      previewUrl,
      error,
      startedAt: status === "running" ? new Date() : null,
    },
  });

  // The main repo's preview still populates Sandbox.previewUrl, so every older
  // reader (task PR bodies, the row's Live preview pill) keeps working.
  await syncSandboxPreviewUrl(sandboxId);

  if (status !== "running") {
    const err = new Error(error ?? "Could not start the process");
    (err as Error & { log?: string }).log = log;
    throw err;
  }

  return { process: toView(plan, updated), log };
}

/** Kill this key's app and tunnel by recorded PID; the group first, then the leader. */
function killBlock(key: string): string {
  // Legacy paths included: a process started before the rename recorded its PID
  // under /tmp/nexux-proc-*, and skipping those would leave it running with no
  // file left to reap it by.
  return `for f in ${procPidPath(key)} ${procTunnelPidPath(key)} ${legacyProcPidPath(key)} ${legacyProcTunnelPidPath(key)}; do
  if [ -f "$f" ]; then
    kill -TERM -"$(cat "$f")" 2>/dev/null || kill -TERM "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
done`;
}

/** Stop one process (and its tunnel). Idempotent: stopping a dead one is fine. */
export async function stopSandboxProcess(
  projectId: string,
  sandboxId: string,
  key: string,
): Promise<void> {
  const sandbox = await loadSandbox(projectId, sandboxId);

  if (sandboxReachable(sandbox)) {
    const plans = await getSandboxProcessPlans(projectId);
    const plan = plans.find((p) => p.key === key);
    const row = (await rowsByKey(sandboxId)).get(key);
    // A launcher's containers outlive its PID, so its stop phase is what
    // actually tears it down — run it before killing the shell that started it.
    const stopCommand =
      plan?.role === "services" ? await resolveStopCommand(projectId, key) : null;
    const cwd = plan?.cwd ?? row?.cwd ?? "/opt/nexus";
    const script = [
      stopCommand ? `cd ${q(cwd)} && ${stopCommand} 2>&1 || true` : "",
      killBlock(key),
      "true",
    ]
      .filter(Boolean)
      .join("\n");
    await execRemote(script, {
      ...sandboxTarget(sandbox, cwd),
      timeoutMs: 120_000,
    }).catch(() => undefined);
  }

  await prisma.sandboxProcess
    .updateMany({
      where: { sandboxId, key },
      data: { status: "stopped", pid: null, previewUrl: null, startedAt: null },
    })
    .catch(() => undefined);

  await syncSandboxPreviewUrl(sandboxId);
}

/** The `stop` phase of the node a launcher key belongs to, if it declares one. */
async function resolveStopCommand(
  projectId: string,
  key: string,
): Promise<string | null> {
  const nodeId = key.includes("#") ? key.split("#")[0] : null;
  if (!nodeId) return null;
  const node = await prisma.stackNode.findFirst({
    where: { id: nodeId, projectId },
    select: { stopCommand: true },
  });
  return node?.stopCommand?.trim() || null;
}

/** Tail one process's log. */
export async function readSandboxProcessLog(
  projectId: string,
  sandboxId: string,
  key: string,
  lines = 400,
): Promise<string> {
  const sandbox = await loadSandbox(projectId, sandboxId);
  if (!sandboxReachable(sandbox)) return "";
  const res = await execRemote(
    // Falls back to the pre-rename log so a process still running from before
    // the upgrade keeps showing output instead of an empty panel.
    `if [ -f ${procLogPath(key)} ]; then tail -n ${lines} ${procLogPath(key)} 2>/dev/null; else tail -n ${lines} ${legacyProcLogPath(key)} 2>/dev/null; fi || true`,
    { ...sandboxTarget(sandbox, "/opt/nexus"), timeoutMs: 30_000 },
  ).catch(() => null);
  return res?.stdout ?? "";
}

/**
 * Keep `Sandbox.previewUrl` pointing at a running tunnel.
 *
 * The column predates per-process previews and every older reader still uses
 * it; rather than leave it stale, it mirrors the first process that has one.
 */
async function syncSandboxPreviewUrl(sandboxId: string): Promise<void> {
  const withTunnel = await prisma.sandboxProcess.findFirst({
    where: { sandboxId, status: "running", NOT: { previewUrl: null } },
    orderBy: { startedAt: "asc" },
  });
  await prisma.sandbox
    .update({
      where: { id: sandboxId },
      data: { previewUrl: withTunnel?.previewUrl ?? null },
    })
    .catch(() => undefined);
}

function toView(
  plan: SandboxProcessPlan,
  row: SandboxProcess,
): SandboxProcessView {
  return {
    ...plan,
    id: row.id,
    status: row.status,
    pid: row.pid,
    previewUrl: row.previewUrl,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    stale: false,
  };
}
