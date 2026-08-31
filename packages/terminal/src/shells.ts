import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

/**
 * Which shell a terminal session runs.
 *
 * On macOS/Linux there is one answer — the user's login shell — and the id is
 * always `posix`. Windows has several genuinely different ones, and a project
 * can live in any of them: `cmd`, `powershell` (the in-box 5.1), `pwsh`
 * (PowerShell 7, separately installed) and one entry per installed WSL distro,
 * whose id carries the distro because a machine commonly has several.
 */
export type ShellKind = "posix" | "cmd" | "powershell" | "pwsh" | "wsl";

export interface ShellSpec {
  /** Stable id sent by the client: `posix`, `cmd`, `pwsh`, `wsl:Ubuntu-24.04`. */
  id: string;
  label: string;
  kind: ShellKind;
  /** WSL only — the distro to launch with `-d`. */
  distro?: string;
}

const WINDOWS_ROOT = process.env.SystemRoot || "C:\\Windows";
const SYSTEM32 = path.join(WINDOWS_ROOT, "System32");

function firstExisting(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

/**
 * The user's login shell, or the first real one we can find.
 *
 * `$SHELL` wins when set, but containers rarely set it and the zsh default only
 * holds on macOS — a Nexus host's bookworm-slim image has bash/sh only, and
 * spawning a missing binary kills the pty with "execvp(3) failed". `/bin/sh`
 * exists everywhere we run.
 */
export function posixShellBinary(): string {
  return (
    firstExisting(process.env.SHELL, "/bin/zsh", "/bin/bash") ?? "/bin/sh"
  );
}

function cmdPath(): string | undefined {
  return firstExisting(process.env.ComSpec, path.join(SYSTEM32, "cmd.exe"));
}

function powershellPath(): string | undefined {
  return firstExisting(
    path.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
}

function pwshPath(): string | undefined {
  // PowerShell 7 installs outside System32 and is not always on PATH for a GUI
  // process, so look where its MSI puts it before giving up.
  const roots = [process.env["ProgramFiles"], process.env["ProgramW6432"]];
  for (const root of roots) {
    if (!root) continue;
    const dir = path.join(root, "PowerShell");
    let versions: string[] = [];
    try {
      versions = fs.readdirSync(dir);
    } catch {
      continue;
    }
    // Highest major first, so a machine with 7 and 8 installed offers 8.
    for (const v of versions.sort().reverse()) {
      const exe = path.join(dir, v, "pwsh.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}

export function wslPath(): string | undefined {
  return firstExisting(path.join(SYSTEM32, "wsl.exe"));
}

/**
 * Installed WSL distributions, in `wsl --list` order (the default one first).
 *
 * `wsl.exe` writes UTF-16LE, so the output has to be decoded as such — read as
 * utf8 it comes back as text interleaved with NULs and every name fails to
 * match. Returns empty when WSL is absent or reports nothing; never throws,
 * because listing shells must not be able to break the terminal.
 */
export function listWslDistros(): string[] {
  const exe = wslPath();
  if (!exe) return [];
  try {
    const out = execFileSync(exe, ["--list", "--quiet"], {
      encoding: "buffer",
      timeout: 5_000,
      windowsHide: true,
    });
    return out
      .toString("utf16le")
      .split(/\r?\n/)
      .map((l) => l.replace(/\0/g, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Every shell this machine can actually start, for the UI to offer. */
export function listShells(): ShellSpec[] {
  if (process.platform !== "win32") {
    const binary = posixShellBinary();
    return [{ id: "posix", label: path.basename(binary), kind: "posix" }];
  }

  const out: ShellSpec[] = [];
  if (powershellPath()) {
    out.push({ id: "powershell", label: "PowerShell", kind: "powershell" });
  }
  if (pwshPath()) {
    out.push({ id: "pwsh", label: "PowerShell 7", kind: "pwsh" });
  }
  if (cmdPath()) {
    out.push({ id: "cmd", label: "Command Prompt", kind: "cmd" });
  }
  for (const distro of listWslDistros()) {
    out.push({
      id: `wsl:${distro}`,
      label: `WSL · ${distro}`,
      kind: "wsl",
      distro,
    });
  }
  return out;
}

/** PowerShell on Windows (the user's pick), the login shell everywhere else. */
export function defaultShellId(): string {
  if (process.platform !== "win32") return "posix";
  if (powershellPath()) return "powershell";
  if (cmdPath()) return "cmd";
  const distro = listWslDistros()[0];
  return distro ? `wsl:${distro}` : "cmd";
}

export function parseShellId(id: string | null | undefined): ShellSpec {
  const wanted = id?.trim() || defaultShellId();
  if (wanted.startsWith("wsl:")) {
    const distro = wanted.slice(4);
    if (distro) {
      return { id: wanted, label: `WSL · ${distro}`, kind: "wsl", distro };
    }
  }
  const known = listShells().find((s) => s.id === wanted);
  if (known) return known;
  // An id from another machine (state restored from localStorage, a picker
  // entry saved before a distro was removed) must not leave the user with a
  // dead terminal and no explanation — fall back and let the caller say so.
  const fallback = defaultShellId();
  return (
    listShells().find((s) => s.id === fallback) ?? {
      id: "posix",
      label: "shell",
      kind: "posix",
    }
  );
}

/**
 * Translate a Windows path to where WSL sees it.
 *
 * Two shapes matter. A path *inside* a distro is reached from Windows through
 * the `\\wsl.localhost\<distro>\…` (or legacy `\\wsl$\…`) UNC share, and its
 * Linux path is whatever follows the distro. A path on a Windows volume is
 * mounted under `/mnt/<drive letter>`. Anything already POSIX is returned as
 * is, so a caller that stored a Linux path keeps working.
 */
export function toWslPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/")) return trimmed;

  const unc = trimmed.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(\\.*)?$/i);
  if (unc) {
    const rest = (unc[1] ?? "").replace(/\\/g, "/");
    return rest || "/";
  }

  const drive = trimmed.match(/^([a-z]):[\\/](.*)$/i);
  if (drive) {
    const rest = drive[2].replace(/\\/g, "/").replace(/\/+$/, "");
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
  }

  return trimmed.replace(/\\/g, "/");
}

/** Single-quote a path for the POSIX shell that runs inside WSL. */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Windows-side cwd for the spawned process; undefined means "leave it". */
  cwd?: string;
}

/**
 * How to start `spec` in `cwd`.
 *
 * WSL is the interesting case: node-pty's cwd is a *Windows* directory, so the
 * Linux working directory has to be a `cd` inside the distro instead. It runs
 * through `bash -lc "cd …; exec bash -l"` — the same shape as the ssh and
 * docker branches — so a path that does not exist yet lands in the home
 * directory rather than killing the session.
 */
export function spawnPlan(spec: ShellSpec, cwd: string): SpawnPlan {
  switch (spec.kind) {
    case "wsl": {
      const exe = wslPath();
      const target = toWslPath(cwd);
      const args = spec.distro ? ["-d", spec.distro] : [];
      // `sh`, not `bash`, as the launcher: a distro is not obliged to have bash
      // (`docker-desktop` is busybox, and dies with "bash: not found" before it
      // can run anything), while `sh` exists in every one of them. bash is
      // still preferred for the session itself when it is there.
      args.push(
        "--",
        "sh",
        "-lc",
        `cd ${shQuote(target)} 2>/dev/null; ` +
          `if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi`,
      );
      // Keep the launcher itself in a directory Windows can chdir to; the
      // session's real cwd is the `cd` above.
      return { file: exe ?? "wsl.exe", args, cwd: undefined };
    }
    case "cmd":
      return { file: cmdPath() ?? "cmd.exe", args: [], cwd };
    case "powershell":
      return {
        file: powershellPath() ?? "powershell.exe",
        args: ["-NoLogo"],
        cwd,
      };
    case "pwsh":
      return { file: pwshPath() ?? "pwsh.exe", args: ["-NoLogo"], cwd };
    case "posix":
    default:
      // `-i` is a POSIX flag; it is what makes the shell read the user's rc
      // files, and it is meaningless (and rejected) by the Windows shells above.
      return { file: posixShellBinary(), args: ["-i"], cwd };
  }
}
