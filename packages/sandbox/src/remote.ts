import { spawn } from "child_process";
import path from "path";
import type { LogSink } from "./types";

// Host keys are recorded next to the sandbox key, not in ~/.ssh: on a Nexus
// host the container's uid has no home directory, so the default known_hosts
// is unwritable and accept-new could never actually pin a host key.
function knownHostsFile(privateKeyPath: string): string {
  return path.join(path.dirname(privateKeyPath), "known_hosts");
}

/** How long an idle multiplexed connection is kept open for the next command. */
export const SSH_CONTROL_PERSIST_SECONDS = 120;

/**
 * Multiplexing options: the first command pays the handshake, the rest ride the
 * open channel.
 *
 * A dispatch is not one remote command, it is eight — checkout, context,
 * attachments, the run, tests, screenshots, push, PR. Each was opening its own
 * connection, and an SSH handshake is six-plus round trips: on a link with
 * 280 ms of latency that is ~3.3 s *per command*, ~26 s of a task spent
 * saying hello. Reused, every command after the first costs one round trip.
 *
 * `%C` hashes host/port/user into a fixed-length name — a socket path built
 * from the host itself can exceed the ~104-byte limit macOS puts on unix
 * sockets, and the failure mode is a connection that silently refuses to
 * multiplex.
 */
function controlArgs(privateKeyPath: string): string[] {
  const dir = path.dirname(privateKeyPath);
  return [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${path.join(dir, "cm-%C")}`,
    "-o",
    `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}`,
  ];
}

export type RemoteResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** True when OUR timeoutMs fired the SIGKILL — not a remote failure. */
  timedOut?: boolean;
};

export type RemoteExecOpts = {
  /** SSH target (cloud sandboxes). Required unless `container` is set. */
  host?: string;
  user?: string;
  privateKeyPath?: string;
  /** Docker container name — local sandboxes exec here instead of SSH. */
  container?: string;
  /** Remote working directory. */
  cwd?: string;
  onLog?: LogSink;
  timeoutMs?: number;
  /**
   * Abort kills the LOCAL transport (ssh / docker exec) with SIGKILL. The
   * remote process usually dies with it (stdout closes → SIGPIPE), but
   * callers that must guarantee it should also pkill remotely.
   */
  signal?: AbortSignal;
};

// Single-quote a value for safe embedding in a remote bash -lc command.
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What `sandboxShellCommand` needs off a Sandbox row to address the machine. */
export type SandboxAddress = {
  provider: string;
  publicIp?: string | null;
  tailscaleIp?: string | null;
  /** Container name for local sandboxes. */
  instanceId?: string | null;
};

/**
 * The command a human pastes into their own terminal to get a shell on a
 * sandbox, or null while there is nothing to connect to yet.
 *
 * Composed on the server because only the server knows where the install keeps
 * its keypair. Nexus authenticates with its own key (`<dataDir>/ssh/id_ed25519`,
 * authorized for both root and the agent user at bootstrap), so a bare
 * `ssh user@ip` — which is what the row used to display — cannot work from
 * outside the app: the user's own keys are not on the box, and the failure
 * reads as "Permission denied (publickey)" rather than "you left out -i".
 *
 * `IdentitiesOnly=yes` for the same reason `execRemote` passes it: an ssh-agent
 * holding several keys offers them all and exhausts the server's MaxAuthTries
 * before reaching this one.
 */
export function sandboxShellCommand(
  sandbox: SandboxAddress,
  opts: { privateKeyPath: string; user: string },
): string | null {
  if (sandbox.provider === "local") {
    // No sshd in a container — the same door `execRemote` uses.
    return sandbox.instanceId
      ? `docker exec -it -u ${opts.user} ${sandbox.instanceId} bash -l`
      : null;
  }
  // The public address is the one that always answers. A tailnet address only
  // works from a machine on the tailnet that can also see this peer, so it is
  // the fallback rather than the default.
  const host = sandbox.publicIp || sandbox.tailscaleIp;
  if (!host) return null;
  // Double quotes around the key path: the only form that survives a paste
  // into bash, PowerShell and cmd alike, and Windows paths have spaces.
  return `ssh -i "${opts.privateKeyPath}" -o IdentitiesOnly=yes ${opts.user}@${host}`;
}

/**
 * Run a command on a sandbox — over SSH (cloud) or docker exec (local).
 *
 * The command runs through `bash -lc` so /etc/profile.d/nexus-env.sh is
 * sourced — the project's env vars (GITHUB_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, …)
 * are therefore available to it. The command string is passed as a single
 * quoted argument; callers must not interpolate untrusted input into it
 * without quoting.
 */
export function execRemote(
  command: string,
  opts: RemoteExecOpts,
): Promise<RemoteResult> {
  const user = opts.user ?? "root";
  const remote = opts.cwd
    ? `cd ${shq(opts.cwd)} && ${command}`
    : command;

  let bin: string;
  let args: string[];
  if (opts.container) {
    bin = "docker";
    // argv goes straight to execve — the command needs no extra quoting here.
    args = ["exec", "-u", user, opts.container, "bash", "-lc", remote];
  } else {
    if (!opts.host || !opts.privateKeyPath) {
      return Promise.reject(
        new Error("execRemote needs either container or host+privateKeyPath"),
      );
    }
    bin = "ssh";
    args = [
      "-i",
      opts.privateKeyPath,
      "-o",
      // Offer only the sandbox key — agent-loaded keys would exhaust the
      // server's MaxAuthTries before it ("Too many authentication failures").
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile(opts.privateKeyPath)}`,
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      ...controlArgs(opts.privateKeyPath),
      "-n", // no stdin — otherwise remote CLIs wait on it
      `${user}@${opts.host}`,
      `bash -lc ${shq(remote)}`,
    ];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;

    let timedOut = false;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
    }

    const onAbort = () => child.kill("SIGKILL");
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.onLog?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      opts.onLog?.(text);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

/**
 * Copy a directory off the instance (screenshots, artifacts…). Returns the
 * names of the files that landed locally. Missing remote dir → empty list.
 */
export function fetchRemoteDir(opts: {
  host?: string;
  user?: string;
  privateKeyPath?: string;
  container?: string;
  remoteDir: string;
  localDir: string;
  timeoutMs?: number;
}): Promise<RemoteResult> {
  const user = opts.user ?? "root";
  let bin: string;
  let args: string[];
  if (opts.container) {
    bin = "docker";
    args = ["cp", `${opts.container}:${opts.remoteDir}/.`, opts.localDir];
  } else {
    if (!opts.host || !opts.privateKeyPath) {
      return Promise.reject(
        new Error("fetchRemoteDir needs either container or host+privateKeyPath"),
      );
    }
    bin = "scp";
    args = [
      "-i",
      opts.privateKeyPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile(opts.privateKeyPath)}`,
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      // Rides the same multiplexed channel execRemote opened, so a transfer
      // between two commands costs no second handshake.
      ...controlArgs(opts.privateKeyPath),
      "-r",
      `${user}@${opts.host}:${opts.remoteDir}/.`,
      opts.localDir,
    ];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: "", stderr });
    });
  });
}

/**
 * Copy a local directory's contents onto the instance (attachments, seeds…).
 * Mirror of fetchRemoteDir. The remote dir must already exist (mkdir -p via
 * execRemote first) — scp/docker cp won't create parents.
 */
export function pushLocalDir(opts: {
  host?: string;
  user?: string;
  privateKeyPath?: string;
  container?: string;
  localDir: string;
  remoteDir: string;
  timeoutMs?: number;
}): Promise<RemoteResult> {
  const user = opts.user ?? "root";
  let bin: string;
  let args: string[];
  if (opts.container) {
    bin = "docker";
    args = ["cp", `${opts.localDir}/.`, `${opts.container}:${opts.remoteDir}`];
  } else {
    if (!opts.host || !opts.privateKeyPath) {
      return Promise.reject(
        new Error("pushLocalDir needs either container or host+privateKeyPath"),
      );
    }
    bin = "scp";
    args = [
      "-i",
      opts.privateKeyPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile(opts.privateKeyPath)}`,
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      // Rides the same multiplexed channel execRemote opened, so a transfer
      // between two commands costs no second handshake.
      ...controlArgs(opts.privateKeyPath),
      "-r",
      `${opts.localDir}/.`,
      `${user}@${opts.host}:${opts.remoteDir}`,
    ];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    }
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: "", stderr });
    });
  });
}

export type ClaudeRunResult = {
  ok: boolean;
  result?: string;
  costUsd?: number;
  durationMs?: number;
  /** Claude Code session — pass it back as resumeSessionId for a follow-up. */
  sessionId?: string;
  error?: string;
};

export type StreamEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
};

/** Turns one stream-json event into a readable progress line (or nothing). */
export function describeEvent(event: StreamEvent): string | null {
  if (event.type === "system" && event.subtype === "init") {
    return "[claude] session started";
  }
  if (event.type === "assistant") {
    const lines: string[] = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) {
        lines.push(block.text.trim().split("\n").slice(0, 4).join("\n"));
      } else if (block.type === "tool_use") {
        // Show the most identifying input (file path, command, pattern).
        const input = block.input ?? {};
        const detail =
          (input.file_path as string) ??
          (input.command as string) ??
          (input.pattern as string) ??
          (input.path as string) ??
          "";
        lines.push(
          `[claude] ${block.name}${detail ? ` ${String(detail).slice(0, 120)}` : ""}`,
        );
      }
    }
    return lines.length ? lines.join("\n") : null;
  }
  if (event.type === "result") {
    return `[claude] finished (${event.subtype ?? "done"})`;
  }
  return null;
}

/**
 * Build the headless Claude Code invocation.
 *
 * bypassPermissions is what makes headless work: acceptEdits only
 * auto-approves file edits, so every Bash call (install, test, git commit)
 * gets denied and the run ends with nothing committed. It requires a
 * non-root user (Claude Code refuses to bypass as root) — hence AGENT_USER.
 * --resume continues a previous session, so a follow-up keeps the full
 * context of what the agent already did instead of starting cold.
 */
export function buildClaudeCommand(
  prompt: string,
  opts: {
    resumeSessionId?: string;
    model?: string;
    /**
     * "plan" runs Claude read-only: no edits, no mutating Bash. That is what
     * lets a planning run share a sandbox with a working run — it cannot
     * touch the working tree, so it does not need the sandbox lock.
     */
    permissionMode?: "plan";
  } = {},
): string {
  const resume = opts.resumeSessionId
    ? `--resume ${shq(opts.resumeSessionId)} `
    : "";
  const model = opts.model?.trim() ? `--model ${shq(opts.model.trim())} ` : "";
  const mode = opts.permissionMode ?? "bypassPermissions";
  return `claude ${resume}${model}-p ${shq(prompt)} --permission-mode ${mode} --output-format stream-json --verbose`;
}

/**
 * Incremental parser for the CLI's stream-json stdout. Chunks may split JSON
 * lines anywhere; non-JSON noise is passed through to the log verbatim.
 * Call `flush()` after the stream ends to process a trailing partial line;
 * `getFinal()` returns the last `result` event seen (the run outcome).
 */
export function createStreamParser(onLog?: LogSink): {
  handleChunk: (chunk: string) => void;
  flush: () => void;
  getFinal: () => StreamEvent | null;
} {
  let final: StreamEvent | null = null;
  let buffer = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("{")) {
      onLog?.(trimmed + "\n"); // non-JSON noise (warnings, etc.)
      return;
    }
    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      return; // partial/garbled line — the stream is best-effort for display
    }
    if (event.type === "result") final = event;
    const text = describeEvent(event);
    if (text) onLog?.(text + "\n");
  };

  return {
    handleChunk: (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    flush: () => {
      if (buffer) handleLine(buffer);
      buffer = "";
    },
    getFinal: () => final,
  };
}

/** Shape the process outcome + final result event into a ClaudeRunResult. */
export function finalizeClaudeRun(
  final: StreamEvent | null,
  res: Pick<RemoteResult, "code" | "stderr" | "timedOut">,
  opts: { timeoutMs?: number } = {},
): ClaudeRunResult {
  if (!final) {
    // Our own watchdog is the likeliest killer of a long run — name it,
    // or the user debugs a cryptic "code -1" instead of raising the cap.
    if (res.timedOut) {
      const min = opts.timeoutMs ? Math.round(opts.timeoutMs / 60_000) : null;
      return {
        ok: false,
        error: `Run killed by the ${min ? `${min}-minute ` : ""}timeout before it could finish. If the task legitimately needs longer, raise the task timeout in the project's sandbox settings and retry.`,
      };
    }
    return {
      ok: false,
      error:
        res.stderr.trim().split("\n").slice(-3).join("\n") ||
        `claude exited with code ${res.code} without a result event`,
    };
  }
  const ok = res.code === 0 && !final.is_error;
  return {
    ok,
    result: final.result,
    costUsd: final.total_cost_usd,
    durationMs: final.duration_ms,
    sessionId: final.session_id,
    error: ok ? undefined : (final.result ?? "Claude reported an error"),
  };
}

/**
 * Run Claude Code headlessly in a repo checkout on the instance.
 *
 * Uses --output-format stream-json so progress is visible while it works;
 * plain `json` buffers everything until the end, which makes a long run look
 * frozen. Each event is turned into a readable log line, and the final
 * `result` event carries the outcome, cost and duration.
 *
 * Needs CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in the instance
 * environment — provided via the project's env vars.
 */
export async function runClaudeTask(
  prompt: string,
  opts: RemoteExecOpts & {
    resumeSessionId?: string;
    model?: string;
    permissionMode?: "plan";
  },
): Promise<ClaudeRunResult> {
  const command = buildClaudeCommand(prompt, opts);
  const parser = createStreamParser(opts.onLog);

  const res = await execRemote(command, {
    ...opts,
    onLog: parser.handleChunk,
  });
  parser.flush();

  return finalizeClaudeRun(parser.getFinal(), res, {
    timeoutMs: opts.timeoutMs,
  });
}
