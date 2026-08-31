// StackRunner: brings a project stack up/down and multiplexes logs.
// In-process singleton on globalThis (same HMR-survival pattern as
// packages/db/src/client.ts). Docker services run via `docker compose`;
// local-mode nodes run as detached host process groups.

import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import net from "net";
import path from "path";
import { prisma } from "@nexux/db";
import { expandHome } from "@nexux/storage";
import { dockerAvailable, docker } from "@nexux/harness";

import { buildProjectCompose, writeComposeFile } from "./compose-io";
import {
  nodePorts,
  resolveNodeDir,
  resolveScriptCommand,
} from "./node-runtime";
import {
  nodePhases,
  phasesWithRole,
  runPhases,
  servicePhases,
} from "./phases";
import type { PortMapping, StackLogLine, StackStatus } from "./types";

const LOG_BUFFER_SIZE = 2000;
const SIGKILL_GRACE_MS = 5000;
/** How long a node waits for a dependency's port before starting anyway. */
const DEP_READY_TIMEOUT_MS = 60_000;
/** How long a node's custom stop command may run before it is killed. */
const STOP_COMMAND_TIMEOUT_MS = 120_000;
/** Installs and builds are slow by nature — a cold `pnpm install` needs room. */
const PREPARE_COMMAND_TIMEOUT_MS = 900_000;

type LocalProc = {
  nodeId: string;
  /** Display name — the node's, suffixed when it runs more than one phase. */
  name: string;
  proc: ChildProcess;
  startedAt: number;
  /** Where the command ran — used to spot containers it left behind. */
  cwd: string;
};

/**
 * Key for `localProcs`. A node can declare several run phases (two servers out
 * of one checkout), so the node id alone would let the second overwrite the
 * first and leave it unstoppable.
 */
const procKey = (nodeId: string, index: number) => `${nodeId}#${index}`;

type ProjectRun = {
  composeFile: string | null;
  composeProjectName: string;
  serviceNames: Record<string, string>; // nodeId -> compose service
  logsFollower: ChildProcess | null;
  localProcs: Map<string, LocalProc>;
  logs: StackLogLine[];
  seq: number;
  emitter: EventEmitter;
  upRunning: boolean;
  prepareRunning: boolean;
};

export type UpResult = { ok: boolean; warnings: string[]; error?: string };

/** Run a shell command to completion, capturing its output. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n(timed out after ${Math.round(timeoutMs / 1000)}s)`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** PIDs listening on a TCP port. Empty when nothing listens or lsof is absent. */
async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const res = await runShell(
      `lsof -ti tcp:${port} -sTCP:LISTEN`,
      process.cwd(),
      5_000
    );
    return res.stdout
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Process-group id of a pid, for signalling a whole dev-server tree at once. */
async function pgidOf(pid: number): Promise<number | null> {
  try {
    const res = await runShell(`ps -o pgid= -p ${pid}`, process.cwd(), 5_000);
    const pgid = Number(res.stdout.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

/**
 * Kill a pid and its process group. A dev server is a tree (`pnpm` → `next` →
 * `next-server`) and the pid that holds the port is usually a leaf, so signal
 * its group — the bare pid would leave the parents running.
 */
async function killProcessTree(pid: number) {
  const pgid = await pgidOf(pid);
  // Never signal our own group — a node pointing at the Nexus repo would
  // otherwise take the dev server down with it.
  const ownPgid = await pgidOf(process.pid);
  if (pid === process.pid || (pgid !== null && pgid === ownPgid)) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (pgid) process.kill(-pgid, sig);
      else process.kill(pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => {
    try {
      // still there? escalate
      process.kill(pid, 0);
      signal("SIGKILL");
    } catch {
      // exited on SIGTERM
    }
  }, SIGKILL_GRACE_MS).unref();
}

/** True when something already listens on the port (ours or not). */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(700);
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, "127.0.0.1", () => done(true));
  });
}

/** Host ports a node publishes, used to probe whether it is up yet. */
function portsOf(
  nodes: Array<{ id: string; ports: unknown }>,
  nodeId: string
): number[] {
  const node = nodes.find((n) => n.id === nodeId);
  const ports = (node?.ports as PortMapping[] | null) ?? [];
  return ports
    .map((p) => p?.host)
    .filter((p): p is number => typeof p === "number" && p > 0);
}

/** Resolves true once something accepts TCP on the port, false on timeout. */
function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = new net.Socket();
      const fail = () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 400);
      };
      socket.setTimeout(1000);
      socket.once("error", fail);
      socket.once("timeout", fail);
      socket.connect(port, "127.0.0.1", () => {
        socket.destroy();
        resolve(true);
      });
    };
    attempt();
  });
}

/**
 * Local nodes in dependency order: an edge `source → target` means source
 * depends on target, so the target starts first. Cycles (and nodes not in the
 * graph) keep their original order rather than dropping out.
 */
function orderLocalNodes<T extends { id: string }>(
  nodes: T[],
  edges: Array<{ sourceId: string; targetId: string }>
): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    // Only edges between local nodes matter here — docker deps are compose's job.
    if (!byId.has(e.sourceId) || !byId.has(e.targetId)) continue;
    deps.set(e.sourceId, [...(deps.get(e.sourceId) ?? []), e.targetId]);
  }
  if (!deps.size) return nodes;

  const ordered: T[] = [];
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id) || onPath.has(id)) return; // cycle: stop, keep going
    onPath.add(id);
    for (const dep of deps.get(id) ?? []) visit(dep);
    onPath.delete(id);
    done.add(id);
    const node = byId.get(id);
    if (node) ordered.push(node);
  };
  for (const n of nodes) visit(n.id);
  return ordered;
}

class StackRunner {
  private runs = new Map<string, ProjectRun>();

  constructor() {
    const cleanup = () => {
      for (const run of this.runs.values()) {
        for (const lp of run.localProcs.values()) this.killTree(lp.proc);
        run.logsFollower?.kill("SIGTERM");
      }
      // docker services intentionally left running — they survive app restarts
    };
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
  }

  private getRun(projectId: string): ProjectRun {
    let run = this.runs.get(projectId);
    if (!run) {
      run = {
        composeFile: null,
        composeProjectName: `nexux-${projectId.toLowerCase()}`,
        serviceNames: {},
        logsFollower: null,
        localProcs: new Map(),
        logs: [],
        seq: 0,
        emitter: new EventEmitter(),
        upRunning: false,
        prepareRunning: false,
      };
      run.emitter.setMaxListeners(50);
      this.runs.set(projectId, run);
    }
    return run;
  }

  private log(run: ProjectRun, source: string, line: string) {
    const entry: StackLogLine = {
      seq: ++run.seq,
      ts: Date.now(),
      source,
      line,
    };
    run.logs.push(entry);
    if (run.logs.length > LOG_BUFFER_SIZE) {
      run.logs.splice(0, run.logs.length - LOG_BUFFER_SIZE);
    }
    run.emitter.emit("line", entry);
  }

  private pipeLines(
    run: ProjectRun,
    stream: NodeJS.ReadableStream | null,
    source: string
  ) {
    if (!stream) return;
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) this.log(run, source, line);
      }
    });
    stream.on("end", () => {
      if (buffer.trim()) this.log(run, source, buffer);
    });
  }

  private killTree(proc: ChildProcess) {
    if (proc.exitCode !== null || !proc.pid) return;
    try {
      // negative pid = process group (proc was spawned detached)
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill("SIGTERM");
    }
    const pid = proc.pid;
    setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          proc.kill("SIGKILL");
        }
      }
    }, SIGKILL_GRACE_MS).unref();
  }

  async up(projectId: string): Promise<UpResult> {
    const run = this.getRun(projectId);
    if (run.upRunning) {
      return { ok: false, warnings: [], error: "Stack is already starting" };
    }

    const compose = await buildProjectCompose(projectId);
    if (!compose) {
      return { ok: false, warnings: [], error: "Project not found" };
    }

    const warnings = [...compose.warnings];
    const hasDocker = !!compose.yaml;
    const localNodes = compose.nodes.filter((n) => n.runMode === "local");

    if (!hasDocker && localNodes.length === 0) {
      return {
        ok: false,
        warnings,
        error: "Nothing to start — the canvas has no runnable nodes.",
      };
    }

    if (hasDocker) {
      if (!(await dockerAvailable())) {
        return {
          ok: false,
          warnings,
          error:
            "Docker daemon not reachable. Start Docker (or switch nodes to local mode).",
        };
      }
      const composeVersion = await docker(["compose", "version"], {
        timeoutMs: 10_000,
      });
      if (composeVersion.exitCode !== 0) {
        return {
          ok: false,
          warnings,
          error: "docker compose v2 not available — install the compose plugin.",
        };
      }
      if (!compose.composeDir) {
        return {
          ok: false,
          warnings,
          error:
            "Project has no workspacePath / main repo local path to write the compose file.",
        };
      }
    }

    run.serviceNames = compose.serviceNames;
    run.upRunning = true;
    this.log(run, "runner", "Starting stack...");

    // Fire and forget — the route responds immediately; progress via logs/status.
    void (async () => {
      try {
        if (hasDocker) {
          const file = await writeComposeFile(compose);
          run.composeFile = file;
          this.log(run, "runner", `Compose file written: ${file}`);

          const upProc = spawn(
            "docker",
            [
              "compose",
              "-f",
              file!,
              "-p",
              run.composeProjectName,
              "up",
              "-d",
              "--build",
            ],
            { stdio: ["ignore", "pipe", "pipe"] }
          );
          this.pipeLines(run, upProc.stdout, "compose");
          this.pipeLines(run, upProc.stderr, "compose");
          const exitCode = await new Promise<number>((resolve) => {
            upProc.on("close", (code) => resolve(code ?? -1));
            upProc.on("error", (err) => {
              this.log(run, "runner", `compose up failed: ${err.message}`);
              resolve(-1);
            });
          });
          if (exitCode !== 0) {
            this.log(run, "runner", `docker compose up exited with ${exitCode}`);
          } else {
            this.log(run, "runner", "Docker services up.");
            this.startLogsFollower(run);
          }
        }

        // Dependencies first: an app wired to depend on an API must not come
        // up before it. Docker gets this from compose's depends_on; local
        // nodes need the same order applied here.
        const ordered = orderLocalNodes(localNodes, compose.edges);
        const startedDeps = new Set<string>();
        for (const node of ordered) {
          // Before starting a dependant, give the things it depends on a
          // chance to actually listen — but only when they declare a port;
          // without one there is nothing to probe.
          const waitFor = compose.edges
            .filter((e) => e.sourceId === node.id && startedDeps.has(e.targetId))
            .flatMap((e) => portsOf(localNodes, e.targetId));
          for (const port of waitFor) {
            const ok = await waitForPort(port, DEP_READY_TIMEOUT_MS);
            this.log(
              run,
              "runner",
              ok
                ? `Dependency port ${port} is accepting connections.`
                : `Timed out waiting for dependency port ${port} — starting "${node.name}" anyway.`
            );
          }
          await this.startLocalNode(projectId, run, node.id);
          startedDeps.add(node.id);
        }
        this.log(run, "runner", "Stack start sequence finished.");
      } catch (err) {
        this.log(run, "runner", `Stack start failed: ${(err as Error).message}`);
      } finally {
        run.upRunning = false;
      }
    })();

    return { ok: true, warnings };
  }

  private startLogsFollower(run: ProjectRun) {
    if (!run.composeFile) return;
    run.logsFollower?.kill("SIGTERM");
    const follower = spawn(
      "docker",
      [
        "compose",
        "-f",
        run.composeFile,
        "-p",
        run.composeProjectName,
        "logs",
        "-f",
        "--tail",
        "50",
        "--no-color",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    // compose logs prefix lines with "service  | ..." — extract service as source
    let buffer = "";
    follower.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = line.match(/^([\w.-]+)\s*\|\s?(.*)$/);
        if (m) this.log(run, m[1], m[2]);
        else this.log(run, "compose", line);
      }
    });
    this.pipeLines(run, follower.stderr, "compose");
    run.logsFollower = follower;
  }

  private async startLocalNode(
    projectId: string,
    run: ProjectRun,
    nodeId: string
  ) {
    const node = await prisma.stackNode.findUnique({
      where: { id: nodeId },
      include: { repository: true },
    });
    if (!node) return;
    // Everything this node boots: the app, or the services it launches. A role
    // may repeat — two servers out of one checkout — so start them all rather
    // than silently honouring the first. Install and build are deliberately not
    // run here; see `prepare`.
    const phases = nodePhases(node);
    const startPhases = [...runPhases(phases), ...servicePhases(phases)];
    if (!startPhases.length) {
      this.log(run, "runner", `"${node.name}" has no local command — skipped.`);
      return;
    }
    if (!node.repository?.localPath) {
      this.log(run, "runner", `"${node.name}" has no repo local path — skipped.`);
      return;
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const e of (node.env as { key: string; value: string }[] | null) ?? []) {
      if (e.key) env[e.key] = e.value;
    }

    for (const [index, phase] of startPhases.entries()) {
      const startCommand = phase.command!;
      const key = procKey(nodeId, index);
      // Only name phases apart when there are several, so the usual one-phase
      // node keeps logging under its own name.
      const label =
        startPhases.length > 1 ? `${node.name} (${phase.role})` : node.name;

      const existing = run.localProcs.get(key);
      if (existing && existing.proc.exitCode === null) {
        this.log(run, "runner", `"${label}" already running (pid ${existing.proc.pid}).`);
        continue;
      }

      // Something outside Nexus may already own the port — say so up front
      // instead of letting the dev server fail with a confusing conflict.
      // Launchers are exempt: the port belongs to the services they manage, and
      // re-running `make docker-up` against them is the idempotent no-op that
      // brings a partially-up stack back to full.
      if (phase.role !== "services") {
        const dirForPorts = resolveNodeDir(node.repository.localPath, node.workdir);
        const script = await resolveScriptCommand(startCommand, dirForPorts);
        let taken = false;
        for (const port of nodePorts(node.ports, startCommand, script)) {
          if (await portInUse(port)) {
            this.log(
              run,
              "runner",
              `Port ${port} is already in use — "${label}" was started outside Nexus, or another process holds it. Skipping start.`
            );
            taken = true;
            break;
          }
        }
        if (taken) continue;
      }

      const dir = phase.workdir ?? node.workdir;
      const cwd = dir
        ? path.join(expandHome(node.repository.localPath), dir)
        : expandHome(node.repository.localPath);

      this.log(run, label, `$ ${startCommand} (cwd: ${cwd})`);
      const proc = spawn(startCommand, {
        cwd,
        env,
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.pipeLines(run, proc.stdout, label);
      this.pipeLines(run, proc.stderr, label);
      proc.on("close", (code) => {
        this.log(run, label, `process exited with ${code ?? "?"}`);
      });
      proc.on("error", (err) => {
        this.log(run, label, `failed to start: ${err.message}`);
      });
      run.localProcs.set(key, {
        nodeId,
        name: label,
        proc,
        startedAt: Date.now(),
        cwd,
      });
    }
  }

  async down(projectId: string): Promise<void> {
    const run = this.getRun(projectId);
    this.log(run, "runner", "Stopping stack...");

    run.logsFollower?.kill("SIGTERM");
    run.logsFollower = null;

    // Custom teardown first: a launcher command (`make docker-up`) leaves work
    // running that killing its already-exited process cannot reach. Run these
    // in reverse dependency order — dependants stop before what they depend on
    // — and for every local node, not just the ones this process started.
    await this.runStopCommands(projectId, run);

    const stoppedIds = new Set<string>();
    for (const lp of run.localProcs.values()) {
      this.log(run, "runner", `Stopping "${lp.name}" (pid ${lp.proc.pid})`);
      this.killTree(lp.proc);
      stoppedIds.add(lp.nodeId);
    }
    run.localProcs.clear();

    // A node we have no handle on may still be up: the runner's memory dies
    // when the dev server is killed, but the servers it spawned keep running
    // and holding their port. Down is an explicit "stop my stack", so stop
    // those too — otherwise they are unstoppable from the UI.
    await this.stopByPort(projectId, run, stoppedIds);

    // Bring compose project down even if this process didn't start it
    // (survives dev-server restarts): resolve the file from the DB if needed.
    let file = run.composeFile;
    if (!file) {
      const compose = await buildProjectCompose(projectId);
      if (compose?.composeDir && compose.yaml) {
        file = path.join(compose.composeDir, "docker-compose.yml");
      }
    }
    if (file) {
      const res = await docker(
        ["compose", "-f", file, "-p", run.composeProjectName, "down"],
        { timeoutMs: 120_000 }
      );
      if (res.stdout.trim()) this.log(run, "compose", res.stdout.trim());
      if (res.stderr.trim()) this.log(run, "compose", res.stderr.trim());
    }
    this.log(run, "runner", "Stack stopped.");
  }

  /**
   * Stop local nodes we hold no process handle for by killing whatever listens
   * on their port. Covers servers orphaned when the dev server was killed
   * without running its cleanup — they are otherwise unstoppable from the UI.
   *
   * Launchers are skipped: their port belongs to containers, which `down`
   * handles through the stop command instead.
   */
  private async stopByPort(
    projectId: string,
    run: ProjectRun,
    alreadyStopped: Set<string>
  ) {
    const nodes = await this.localNodeIndex(projectId);
    for (const node of nodes.values()) {
      if (alreadyStopped.has(node.id) || node.managesServices) continue;
      for (const port of node.ports) {
        const pids = await pidsOnPort(port);
        if (!pids.length) continue;
        this.log(
          run,
          "runner",
          `Stopping "${node.name}" on port ${port} (pid ${pids.join(", ")}) — not started by this process.`
        );
        for (const pid of pids) await killProcessTree(pid);
      }
    }
  }

  /**
   * Run every local node's stop phases, dependants first. Failures are logged
   * and skipped — one broken teardown must not block the rest of Down. A node
   * may declare several, and skipping any would leave something running.
   */
  private async runStopCommands(projectId: string, run: ProjectRun) {
    const [allNodes, edges] = await Promise.all([
      prisma.stackNode.findMany({
        where: { projectId, runMode: "local" },
        include: { repository: { select: { localPath: true } } },
      }),
      prisma.stackEdge.findMany({
        where: { projectId },
        select: { sourceId: true, targetId: true },
      }),
    ]);
    // The teardowns a node declares, wherever they are stored — persisted stop
    // phases, or one derived from the legacy column.
    const stopPhases = new Map(
      allNodes.map((n) => [
        n.id,
        phasesWithRole(nodePhases(n), "stop").filter((p) => p.command),
      ])
    );
    const nodes = allNodes.filter((n) => stopPhases.get(n.id)?.length);
    if (!nodes.length) return;

    // up() starts dependencies first; down() reverses that.
    const ordered = orderLocalNodes(nodes, edges).reverse();

    for (const node of ordered) {
      for (const stop of stopPhases.get(node.id) ?? []) {
        const command = stop.command!;
        const cwd = resolveNodeDir(
          node.repository?.localPath,
          stop.workdir ?? node.workdir
        );
        if (!cwd) {
          this.log(
            run,
            "runner",
            `"${node.name}" has no repo local path — stop command skipped.`
          );
          continue;
        }
        this.log(run, node.name, `$ ${command} (cwd: ${cwd})`);
        try {
          const res = await runShell(command, cwd, STOP_COMMAND_TIMEOUT_MS);
          for (const line of `${res.stdout}${res.stderr}`.split("\n")) {
            if (line.trim()) this.log(run, node.name, line.trimEnd());
          }
          if (res.exitCode !== 0) {
            this.log(
              run,
              "runner",
              `"${node.name}" stop command exited with ${res.exitCode}.`
            );
          }
        } catch (err) {
          this.log(
            run,
            "runner",
            `"${node.name}" stop command failed: ${(err as Error).message}`
          );
        }
      }
    }
  }

  /**
   * Run every local node's `install` and `build` phases, dependencies first.
   *
   * Deliberately not part of `up`: installing and building can take minutes,
   * and Up is meant to be the cheap "start what is already prepared" action.
   * Until now these phases only ever ran inside a sandbox, so the canvas showed
   * fields that did nothing locally — this is what makes them real on the host.
   */
  async prepare(projectId: string): Promise<UpResult> {
    const run = this.getRun(projectId);
    if (run.prepareRunning) {
      return { ok: false, warnings: [], error: "Preparation already running" };
    }

    const [nodes, edges] = await Promise.all([
      prisma.stackNode.findMany({
        where: { projectId, runMode: "local" },
        include: { repository: { select: { localPath: true } } },
      }),
      prisma.stackEdge.findMany({
        where: { projectId },
        select: { sourceId: true, targetId: true },
      }),
    ]);

    const steps = orderLocalNodes(nodes, edges).flatMap((node) =>
      nodePhases(node)
        .filter((p) => (p.role === "install" || p.role === "build") && p.command)
        .map((phase) => ({ node, phase }))
    );
    if (!steps.length) {
      return {
        ok: false,
        warnings: [],
        error: "No install or build phases on the canvas.",
      };
    }

    run.prepareRunning = true;
    this.log(run, "runner", `Preparing ${steps.length} step(s)...`);

    // Fire and forget, like up() — the route answers now, progress via logs.
    void (async () => {
      try {
        for (const { node, phase } of steps) {
          const cwd = resolveNodeDir(
            node.repository?.localPath,
            phase.workdir ?? node.workdir
          );
          if (!cwd) {
            this.log(
              run,
              "runner",
              `"${node.name}" has no repo local path — ${phase.role} skipped.`
            );
            continue;
          }
          this.log(run, node.name, `$ ${phase.command} (cwd: ${cwd})`);
          try {
            const res = await runShell(
              phase.command!,
              cwd,
              PREPARE_COMMAND_TIMEOUT_MS
            );
            for (const line of `${res.stdout}${res.stderr}`.split("\n")) {
              if (line.trim()) this.log(run, node.name, line.trimEnd());
            }
            if (res.exitCode !== 0) {
              // A failed install makes the build after it meaningless, but the
              // other nodes are independent — keep going rather than abort all.
              this.log(
                run,
                "runner",
                `"${node.name}" ${phase.role} exited with ${res.exitCode}.`
              );
            }
          } catch (err) {
            this.log(
              run,
              "runner",
              `"${node.name}" ${phase.role} failed: ${(err as Error).message}`
            );
          }
        }
        this.log(run, "runner", "Preparation finished.");
      } finally {
        run.prepareRunning = false;
      }
    })();

    return { ok: true, warnings: [] };
  }

  async status(projectId: string): Promise<StackStatus> {
    const run = this.runs.get(projectId);
    const composeProjectName = `nexux-${projectId.toLowerCase()}`;

    const composeStatus: StackStatus["compose"] = [];
    try {
      const res = await docker(
        ["compose", "-p", composeProjectName, "ps", "--format", "json"],
        { timeoutMs: 10_000 }
      );
      if (res.exitCode === 0 && res.stdout.trim()) {
        // one JSON object per line (compose v2) or a JSON array (older builds)
        const text = res.stdout.trim();
        const items: Array<{ Service?: string; State?: string }> =
          text.startsWith("[")
            ? JSON.parse(text)
            : text
                .split("\n")
                .filter(Boolean)
                .map((l) => JSON.parse(l));
        for (const item of items) {
          if (item.Service) {
            composeStatus.push({
              service: item.Service,
              state: item.State ?? "unknown",
            });
          }
        }
      }
    } catch {
      // docker not available — report no compose services
    }

    // A node flagged `managesServices` runs a launcher (`make docker-up`,
    // `docker compose up -d`): it starts detached containers and exits 0, so
    // its process being gone says nothing — liveness comes from the containers
    // it left in the node's directory. Only those nodes get container-probed;
    // for everything else an exited process really does mean stopped.
    const localNodes = await this.localNodeIndex(projectId);
    const anyManaged = [...localNodes.values()].some((n) => n.managesServices);
    const launchedDirs = anyManaged
      ? await this.composeDirsUp()
      : new Set<string>();

    const local: StackStatus["local"] = [];
    const tracked = new Set<string>();
    // A node may hold several processes (one per run phase). The canvas keys
    // status by node, so collapse them: the node counts as running while any of
    // its phases is, and reports that phase's pid.
    const byNode = new Map<string, StackStatus["local"][number]>();
    for (const lp of run?.localProcs.values() ?? []) {
      tracked.add(lp.nodeId);
      const alive = lp.proc.exitCode === null;
      const node = localNodes.get(lp.nodeId);
      let running = alive;
      if (!alive && lp.proc.exitCode === 0 && node?.managesServices) {
        // `cwd` is missing for procs recorded before a code reload — fall
        // back to the node's own directory.
        const dir = lp.cwd ? path.resolve(lp.cwd) : node.dir;
        running = !!dir && launchedDirs.has(dir);
      }
      const seen = byNode.get(lp.nodeId);
      if (!seen) {
        byNode.set(lp.nodeId, {
          nodeId: lp.nodeId,
          name: node?.name ?? lp.name,
          pid: lp.proc.pid ?? null,
          running,
        });
        continue;
      }
      // Prefer a running phase's pid — a dead one tells the user nothing.
      if (running && !seen.running) {
        seen.running = true;
        seen.pid = lp.proc.pid ?? null;
      }
    }
    local.push(...byNode.values());

    // Nodes this process never started: the runner's memory dies with the dev
    // server, but containers and stray `pnpm dev` processes do not. Credit a
    // node whose directory still has containers up, or whose port is being
    // served by something else — an external server occupying the port is why
    // `up` would fail, so it must not read as stopped.
    for (const node of localNodes.values()) {
      if (tracked.has(node.id)) continue;
      if (node.managesServices && node.dir && launchedDirs.has(node.dir)) {
        local.push({ nodeId: node.id, name: node.name, pid: null, running: true });
        continue;
      }
      const port = node.ports.find(Boolean);
      if (port && (await portInUse(port))) {
        local.push({
          nodeId: node.id,
          name: node.name,
          pid: null,
          running: true,
          external: true,
          port,
        });
      }
    }

    const running =
      (run?.upRunning ?? false) ||
      composeStatus.some((s) => s.state === "running") ||
      local.some((l) => l.running);

    return { running, compose: composeStatus, local };
  }

  /**
   * Every local node of a project, keyed by id, with the directory its command
   * runs in and the ports worth probing.
   */
  private async localNodeIndex(projectId: string): Promise<
    Map<
      string,
      {
        id: string;
        name: string;
        dir: string | null;
        ports: number[];
        managesServices: boolean;
      }
    >
  > {
    const nodes = await prisma.stackNode.findMany({
      where: { projectId, runMode: "local" },
      select: {
        id: true,
        name: true,
        workdir: true,
        ports: true,
        localCommand: true,
        managesServices: true,
        repository: { select: { localPath: true } },
      },
    });
    const entries = await Promise.all(
      nodes.map(async (n) => {
        const dir = resolveNodeDir(n.repository?.localPath, n.workdir);
        const script = await resolveScriptCommand(n.localCommand, dir);
        return [
          n.id,
          {
            id: n.id,
            name: n.name,
            dir,
            ports: nodePorts(n.ports, n.localCommand, script),
            managesServices: n.managesServices,
          },
        ] as const;
      })
    );
    return new Map(entries);
  }

  /** Directory a local node's command runs in — same rule as startLocalNode. */
  private async nodeDir(nodeId: string): Promise<string | null> {
    const node = await prisma.stackNode.findUnique({
      where: { id: nodeId },
      select: { workdir: true, repository: { select: { localPath: true } } },
    });
    return resolveNodeDir(node?.repository?.localPath, node?.workdir);
  }

  /**
   * Working directories of every compose project with a running container —
   * regardless of project name, so a repo's own Makefile/compose counts too.
   */
  private async composeDirsUp(): Promise<Set<string>> {
    const dirs = new Set<string>();
    try {
      const res = await docker(
        [
          "ps",
          "--filter",
          "status=running",
          "--format",
          '{{.Label "com.docker.compose.project.working_dir"}}',
        ],
        { timeoutMs: 10_000 }
      );
      if (res.exitCode !== 0) return dirs;
      for (const line of res.stdout.split("\n")) {
        const dir = line.trim();
        if (dir) dirs.add(path.resolve(dir));
      }
    } catch {
      // docker not available — no containers to credit
    }
    return dirs;
  }

  getLogs(projectId: string, since = 0): StackLogLine[] {
    const run = this.runs.get(projectId);
    if (!run) return [];
    return run.logs.filter((l) => l.seq > since);
  }

  subscribe(
    projectId: string,
    onLine: (line: StackLogLine) => void
  ): () => void {
    const run = this.getRun(projectId);
    run.emitter.on("line", onLine);
    return () => run.emitter.off("line", onLine);
  }
}

const globalForRunner = globalThis as unknown as {
  __nexuxStackRunner?: StackRunner;
};

export const stackRunner = (globalForRunner.__nexuxStackRunner ??=
  new StackRunner());
