// A project's apps running on this Mac as plain processes (spec 39: the chat's
// Run card). Each command starts detached — its own process group, output to a
// log file — so it outlives a window reload, a closed terminal and a restart
// of Nexus itself. A small registry (data dir/run/processes.json) remembers
// them; a process is "running" while its pid is alive. Viewing one is a
// terminal tailing its log; stopping it signals its whole group.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { getConfig } from "@nexux/config";

export type LocalProcess = {
  id: string;
  projectId: string;
  repo: string;
  label: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  logPath: string;
  /** Set once it was stopped from here, so an exit reads as "stopped", not "crashed". */
  stoppedAt?: string;
};

export type LocalProcessView = LocalProcess & { running: boolean; url: string | null };

const runDir = () => path.join(getConfig().dataDir, "run");
const registryPath = () => path.join(runDir(), "processes.json");

function readRegistry(): LocalProcess[] {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), "utf8")) as unknown;
    return Array.isArray(data) ? (data as LocalProcess[]) : [];
  } catch {
    return [];
  }
}

function writeRegistry(list: LocalProcess[]) {
  fs.mkdirSync(runDir(), { recursive: true });
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, registryPath());
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The first local URL a dev server printed ("http://localhost:3002"), from its log's tail. Pure. */
export function firstLocalUrl(log: string): string | null {
  // ANSI colours split URLs in some tools' output.
  const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
  const m = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[^\s'"]*)?/i.exec(plain);
  return m ? m[0].replace("0.0.0.0", "localhost").replace(/[).,]+$/, "") : null;
}

function logHead(file: string, bytes = 64 * 1024): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const n = fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * Each process with whether it still runs. Ones that ended are kept for a
 * while (so a crash is visible), then dropped from the registry.
 */
export function listLocalProcesses(projectId?: string, keepEndedMs = 30 * 60_000): LocalProcessView[] {
  const now = Date.now();
  const all = readRegistry();
  const kept = all.filter((p) => isAlive(p.pid) || now - new Date(p.stoppedAt ?? p.startedAt).getTime() < keepEndedMs);
  if (kept.length !== all.length) writeRegistry(kept);
  return kept
    .filter((p) => !projectId || p.projectId === projectId)
    .map((p) => ({ ...p, running: isAlive(p.pid), url: firstLocalUrl(logHead(p.logPath)) }));
}

/** The user's login shell, so PATH has what their terminal has (nvm, bun, Homebrew). */
function loginShell(): string {
  const shell = process.env.SHELL;
  return shell && fs.existsSync(shell) ? shell : "/bin/zsh";
}

export function startLocalProcess(input: { projectId: string; repo: string; label: string; command: string; cwd: string }): LocalProcess {
  if (/[\r\n]/.test(input.command)) throw new Error("One line per command");
  if (!fs.existsSync(input.cwd)) throw new Error(`The folder ${input.cwd} is not on this machine`);
  // One process per repository: a second Run replaces the first.
  for (const p of readRegistry()) {
    if (p.projectId === input.projectId && p.repo === input.repo && isAlive(p.pid)) stopLocalProcess(p.id);
  }
  const id = `proc_${randomBytes(6).toString("hex")}`;
  fs.mkdirSync(path.join(runDir(), "logs"), { recursive: true });
  const logPath = path.join(runDir(), "logs", `${id}.log`);
  const out = fs.openSync(logPath, "a");
  fs.writeSync(out, `$ ${input.command}\n`);
  // -l -i: a login, interactive shell reads the same profile files the user's
  // terminal does. Detached: its own session and process group, not tied to
  // this server — it keeps running when Nexus restarts.
  const child = spawn(loginShell(), ["-l", "-i", "-c", input.command], {
    cwd: input.cwd,
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  fs.closeSync(out);
  child.unref();
  if (!child.pid) throw new Error("Could not start the process");
  const proc: LocalProcess = {
    id,
    projectId: input.projectId,
    repo: input.repo,
    label: input.label,
    command: input.command,
    cwd: input.cwd,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
  };
  writeRegistry([...readRegistry(), proc]);
  return proc;
}

/** Stop it and everything it started (its process group): SIGTERM + SIGHUP, then SIGKILL if it lingers. */
export function stopLocalProcess(id: string): boolean {
  const list = readRegistry();
  const proc = list.find((p) => p.id === id);
  if (!proc) return false;
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      try {
        process.kill(proc.pid, sig);
      } catch {
        // already gone
      }
    }
  };
  // An interactive shell ignores SIGTERM; SIGHUP closes it and what it runs.
  signalGroup("SIGTERM");
  signalGroup("SIGHUP");
  setTimeout(() => isAlive(proc.pid) && signalGroup("SIGKILL"), 5000).unref();
  writeRegistry(list.map((p) => (p.id === id ? { ...p, stoppedAt: new Date().toISOString() } : p)));
  return true;
}

export function getLocalProcess(id: string): LocalProcess | null {
  return readRegistry().find((p) => p.id === id) ?? null;
}
