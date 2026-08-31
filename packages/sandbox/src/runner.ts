// Brain dispatcher: one entry point for headless agent runs in a sandbox,
// whichever CLI (Claude Code or OpenCode) the project delegates to. Drivers
// (task-manager, dev-console) call runAgentTask and stay brain-agnostic.

import type { SandboxBrain } from "./types";
import {
  execRemote,
  runClaudeTask,
  shq,
  type ClaudeRunResult,
  type RemoteExecOpts,
  type RemoteResult,
} from "./remote";
import type { LogSink } from "./types";

/** Shared result shape for any brain — same contract as ClaudeRunResult. */
export type AgentRunResult = ClaudeRunResult;

export type AgentRunOpts = RemoteExecOpts & {
  resumeSessionId?: string;
  model?: string;
};

/**
 * Build the headless OpenCode invocation.
 *
 * --format json streams raw JSON events to stdout (line-delimited), the
 * OpenCode equivalent of claude's stream-json. --auto approves anything the
 * config would `ask` for (explicit deny rules still hold) — required for
 * unattended runs. -s resumes a session (like claude --resume); -m takes
 * "provider/model".
 */
export function buildOpenCodeCommand(
  prompt: string,
  opts: { resumeSessionId?: string; model?: string } = {},
): string {
  const session = opts.resumeSessionId
    ? `-s ${shq(opts.resumeSessionId)} `
    : "";
  const model = opts.model?.trim() ? `-m ${shq(opts.model.trim())} ` : "";
  return `opencode run ${session}${model}--format json --auto ${shq(prompt)}`;
}

// OpenCode event lines are looser than claude's: shapes vary by version, so
// the parser extracts best-effort and never throws. What we mine:
// - session id: any `sessionID` property (top level or nested in `part`)
// - assistant text: text parts (`{type:"text", text}`)
// - tool calls: tool parts (`{type:"tool", tool, state:{input}}`)
type OpenCodeEvent = {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    sessionID?: string;
    state?: { input?: Record<string, unknown>; status?: string };
  };
  properties?: OpenCodeEvent;
  [key: string]: unknown;
};

/** Turns one OpenCode JSON event into a readable progress line (or nothing). */
export function describeOpenCodeEvent(event: OpenCodeEvent): string | null {
  // Some versions nest the payload under `properties` (server-event style).
  const payload = event.properties ?? event;
  const part = payload.part;
  if (!part) return null;
  if (part.type === "text" && part.text?.trim()) {
    return part.text.trim().split("\n").slice(0, 4).join("\n");
  }
  if (part.type === "tool" && part.tool) {
    const input = part.state?.input ?? {};
    const detail =
      (input.filePath as string) ??
      (input.file_path as string) ??
      (input.command as string) ??
      (input.pattern as string) ??
      (input.path as string) ??
      "";
    return `[opencode] ${part.tool}${detail ? ` ${String(detail).slice(0, 120)}` : ""}`;
  }
  return null;
}

/**
 * Incremental parser for `opencode run --format json` stdout. Mirrors the
 * claude stream parser contract: chunk-safe, noise passthrough, flush() for
 * the trailing line. Collects the last text part as the run result and the
 * session id for resume.
 */
export function createOpenCodeStreamParser(onLog?: LogSink): {
  handleChunk: (chunk: string) => void;
  flush: () => void;
  getSessionId: () => string | undefined;
  getLastText: () => string | undefined;
} {
  let buffer = "";
  let sessionId: string | undefined;
  let lastText: string | undefined;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("{")) {
      onLog?.(trimmed + "\n"); // non-JSON noise (warnings, plain text output)
      return;
    }
    let event: OpenCodeEvent;
    try {
      event = JSON.parse(trimmed) as OpenCodeEvent;
    } catch {
      return; // partial/garbled line — display is best-effort
    }
    const payload = event.properties ?? event;
    sessionId =
      (payload.part?.sessionID as string | undefined) ??
      (payload.sessionID as string | undefined) ??
      sessionId;
    if (payload.part?.type === "text" && payload.part.text?.trim()) {
      lastText = payload.part.text.trim();
    }
    const text = describeOpenCodeEvent(event);
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
    getSessionId: () => sessionId,
    getLastText: () => lastText,
  };
}

/** Shape the process outcome into the shared AgentRunResult contract. */
export function finalizeOpenCodeRun(
  parsed: { sessionId?: string; lastText?: string },
  res: Pick<RemoteResult, "code" | "stderr">,
  durationMs: number,
): AgentRunResult {
  const ok = res.code === 0;
  return {
    ok,
    result: parsed.lastText,
    // OpenCode does not report per-run cost in the event stream (only
    // `opencode stats` aggregates) — left undefined on purpose.
    costUsd: undefined,
    durationMs,
    sessionId: parsed.sessionId,
    error: ok
      ? undefined
      : res.stderr.trim().split("\n").slice(-3).join("\n") ||
        parsed.lastText ||
        `opencode exited with code ${res.code}`,
  };
}

/**
 * Run OpenCode headlessly in a repo checkout on the instance. Mirror of
 * runClaudeTask: needs the provider API keys (OPENAI_API_KEY, ... — injected
 * via the sandbox env) and the config written by the installOpenCode
 * bootstrap block.
 */
export async function runOpenCodeTask(
  prompt: string,
  opts: AgentRunOpts,
): Promise<AgentRunResult> {
  const command = buildOpenCodeCommand(prompt, opts);
  const parser = createOpenCodeStreamParser(opts.onLog);
  const startedAt = Date.now();

  const res = await execRemote(command, {
    ...opts,
    onLog: parser.handleChunk,
  });
  parser.flush();

  return finalizeOpenCodeRun(
    { sessionId: parser.getSessionId(), lastText: parser.getLastText() },
    res,
    Date.now() - startedAt,
  );
}

/** Dispatch a headless agent run to the sandbox's configured brain. */
export function runAgentTask(
  brain: SandboxBrain | string | null | undefined,
  prompt: string,
  opts: AgentRunOpts,
): Promise<AgentRunResult> {
  return brain === "opencode"
    ? runOpenCodeTask(prompt, opts)
    : runClaudeTask(prompt, opts);
}
