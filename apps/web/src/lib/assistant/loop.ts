/**
 * The assistants' tool loop (spec 30 phase 1), extracted from the Stack
 * assistant so every assistant runs the same one.
 *
 * Tool calling is a text protocol over plain agent turns: the model asks for a
 * tool with a single ```json {"tool","args"} block, the server runs it and
 * answers `TOOL_RESULT <tool>: …` as the next message. It works with every
 * provider the host model can be (the agents-generator backend's native
 * callback tools are not compatible with the SDK in use), and native function
 * calling can later sit behind the same interface.
 *
 * Reads run; writes ask. A tool marked `write` is never executed here: the
 * loop stops and hands back the request as a pending action, which only runs
 * when the user approves it. The model reads task logs and repo files that
 * other people and agents wrote — with writes gated, instructions hidden in
 * that text can at most propose a card the user declines.
 */

import type { InlineMessage } from "@ideascol/agents-generator-sdk";

import type { RunnableAgent } from "@/services/agent-deps";

export type LoopTool = {
  name: string;
  description: string;
  /** JSON Schema of `args`, as shown to the model. */
  inputSchema: Record<string, unknown>;
  kind: "read" | "write";
  run(args: Record<string, unknown>): Promise<unknown>;
};

export type LoopToolCall = { tool: string; args: Record<string, unknown>; result: unknown };

export type LoopResult = {
  /** The model's last reply — the visible answer, or the write request. */
  raw: string;
  /** Read tools that ran this turn, in order. */
  toolCalls: LoopToolCall[];
  /** A write the model asked for; not run. */
  pending: { tool: string; args: Record<string, unknown> } | null;
  /** The turn as model history: prior history + every exchange of this turn, including `raw`. */
  history: InlineMessage[];
};

export const MAX_TOOL_ITERATIONS = 6;
export const MAX_TOOL_RESULT_CHARS = 24_000;

/** A reply that IS a tool call: one ```json block with a known `tool`. */
export function parseToolRequest(
  response: string,
  known: ReadonlySet<string>,
): { tool: string; args: Record<string, unknown> } | null {
  const match = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { tool?: unknown; args?: unknown };
    if (typeof parsed.tool !== "string" || !known.has(parsed.tool)) return null;
    return {
      tool: parsed.tool,
      args: parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {},
    };
  } catch {
    return null;
  }
}

/** The message that carries a tool's result back to the model. */
export function toolResultMessage(tool: string, result: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const serialized = JSON.stringify(result) ?? "null";
  return `TOOL_RESULT ${tool}: ${serialized.length > max ? serialized.slice(0, max) + '..."(truncated)' : serialized}`;
}

/** The tool section of a system prompt, generated from the tools themselves. */
export function renderToolCatalog(tools: LoopTool[]): string {
  const lines = tools.map((t) => {
    const schema = JSON.stringify(t.inputSchema);
    return `- ${t.name}${t.kind === "write" ? " [WRITE — needs the user's approval]" : ""} — ${t.description} Args schema: ${schema}`;
  });
  return `## Tools

To call a tool, reply with ONLY a single json code block (no other text):

\`\`\`json
{ "tool": "<name>", "args": { ... } }
\`\`\`

You receive the result as the next message, prefixed TOOL_RESULT. Call tools one per reply, as many as you need.

Tools marked [WRITE] are not run when you ask: the user sees a card describing the action and decides — so do not also ask for confirmation in prose; requesting the tool is the question. If they run it you will receive its TOOL_RESULT; if not, you will be told. Never claim a write happened before you have its TOOL_RESULT. Ask for one write at a time.

${lines.join("\n")}`;
}

/**
 * Run one user turn: the model may call read tools up to `maxIterations`
 * times; a write request, or a reply that is not a tool call, ends the turn.
 */
export async function runToolLoop(opts: {
  agent: RunnableAgent;
  tools: LoopTool[];
  /** The user's message, or a TOOL_RESULT resuming after an approval. */
  message: string;
  history: InlineMessage[];
  maxIterations?: number;
  /** Each read as it completes — for persisting and streaming step by step. */
  onToolCall?: (call: LoopToolCall) => Promise<void> | void;
}): Promise<LoopResult> {
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const known = new Set(byName.keys());
  const history: InlineMessage[] = [...opts.history];
  const toolCalls: LoopToolCall[] = [];
  let message = opts.message;
  let raw = "";

  for (let i = 0; i < (opts.maxIterations ?? MAX_TOOL_ITERATIONS); i++) {
    const result = await opts.agent.run(message, { history });
    raw = result.message || "";
    history.push({ role: "user", content: message } as InlineMessage);
    history.push({ role: "assistant", content: raw } as InlineMessage);

    const request = parseToolRequest(raw, known);
    if (!request) return { raw, toolCalls, pending: null, history };

    const tool = byName.get(request.tool)!;
    if (tool.kind === "write") return { raw, toolCalls, pending: request, history };

    // Not caught: MCP tools answer errors as results (callTool never throws)
    // and the context tools do the same, so a throw here is a bug to surface,
    // not a message for the model.
    const result2 = await tool.run(request.args);
    const done: LoopToolCall = { tool: request.tool, args: request.args, result: result2 };
    toolCalls.push(done);
    await opts.onToolCall?.(done);
    message = toolResultMessage(request.tool, result2);
  }
  // Out of iterations while still calling tools: the last reply is a tool
  // request nobody will answer. Say so rather than show raw JSON.
  return {
    raw: "I ran out of tool steps for this turn before finishing. Ask me to continue.",
    toolCalls,
    pending: null,
    history,
  };
}
