/**
 * The global assistant's threads (spec 30 phase 1): a turn runs the shared
 * tool loop over the MCP tools (plus the context tools when the thread has a
 * project in focus), and everything it did is kept as events — what the user
 * said, each tool call and result, the reply, and any write it asked for.
 *
 * A write is never run by the turn. It becomes an AssistantAction the user
 * approves or cancels; approving runs it through `callTool` and resumes the
 * loop with its result, so the assistant can react to what happened.
 *
 * The model's history is rebuilt from the events every turn — the exact
 * texts it saw, in order — so a reload, a restart or a second tab changes
 * nothing about what it remembers.
 */

import type { InlineMessage } from "@ideascol/agents-generator-sdk";
import { Prisma, prisma } from "@nexux/db";
import { SCOPES, type NexuxContext, type Scope } from "@nexux/mcp";

import { createMcpContext } from "@/lib/mcp-context";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace";
import { defaultAgentDeps, type RunnableAgent } from "@/services/agent-deps";
import { renderToolCatalog, runToolLoop, toolResultMessage, type LoopResult, type LoopTool } from "./loop";
import { contextTools, mcpTools } from "./tools";

export type AssistantDeps = {
  defineAgent(spec: { name: string; instructions: string; workspaceId?: string }): Promise<RunnableAgent>;
  /** The MCP context tools run against; a fake in tests. */
  ctx(): NexuxContext;
};

export function defaultAssistantDeps(): AssistantDeps {
  return { defineAgent: defaultAgentDeps().defineAgent, ctx: createMcpContext };
}

export type EventKind = "user" | "assistant" | "tool_call" | "tool_result" | "action" | "watch_report" | "error";

type EventContent = {
  /** What the model saw or said, verbatim — history is rebuilt from it. */
  text: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  actionId?: string;
  summary?: string;
  /** Route context the user's message was sent with. */
  context?: { projectId?: string | null };
};

const INSTRUCTIONS = `You are the Nexus assistant, inside Nexux — a local-first orchestrator where AI agents build software in sandboxes. You act for the user through the tools below: you can see their projects, sandboxes and tasks, launch and pause sandboxes, give an agent a task, read how it is going, validate and repair a project's stack, and reset a sandbox's seed data.

How to work:
- Ground answers in tool results; do not guess ids, names or states — look them up.
- Before a write, make sure you have what it needs (the project id, the sandbox that should run it). Ask the user when a choice is theirs to make (which project, cloud or local, which endpoint).
- One write at a time. Do not ask for permission in prose: requesting a [WRITE] tool IS asking — the user gets a card with Run / Cancel. When the request is clear, request the tool directly.
- A task you create runs for minutes to an hour; tell the user how to follow it rather than claiming it finished.
- Be brief. Answer in the user's language.

{{FOCUS}}

{{TOOLS}}`;

function focusLine(projectId: string | null, projectName: string | null): string {
  return projectId
    ? `The user is looking at the project "${projectName ?? projectId}" (id ${projectId}). "This project", "a sandbox", "the stack" mean this one unless they say otherwise. You also have its context tools: get_stack_context, read_repo_file, search_project.`
    : "The user is not on a project page; ask which project when it matters.";
}

/** One line a person can decide on — built from the tool and its arguments. */
export function summarizeAction(tool: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : null);
  switch (tool) {
    case "nexux_launch_sandbox":
      return `Launch a ${s("provider") ?? "new"} sandbox${s("dockerEndpoint") ? ` on ${s("dockerEndpoint")}` : ""}${s("name") ? ` named ${s("name")}` : ""} for project ${s("projectId")}`;
    case "nexux_create_task":
      return `Start a task in sandbox ${s("sandboxId")}: “${(s("prompt") ?? "").slice(0, 140)}”`;
    case "nexux_sandbox_power":
      return `${s("action") === "pause" ? "Pause" : "Resume"} sandbox ${s("sandboxId")}`;
    case "nexux_reset_sandbox_data":
      return `Reset ${s("service") ?? "every seeded database"} in sandbox ${s("sandboxId")} to the project's seed (its current data is lost)`;
    case "nexux_repair_stack":
      return `Repair the stack of project ${s("projectId")} (edits the canvas, may run validations)`;
    default:
      return `${tool} ${JSON.stringify(args)}`;
  }
}

// --- threads -----------------------------------------------------------------

export async function createThread(opts: { projectId?: string | null; scopes?: Scope[] } = {}) {
  return prisma.assistantThread.create({
    data: {
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId: opts.projectId ?? null,
      scopes: (opts.scopes ?? [...SCOPES]) as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function listThreads() {
  return prisma.assistantThread.findMany({
    where: { workspaceId: DEFAULT_WORKSPACE_ID },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, projectId: true, createdAt: true, updatedAt: true },
  });
}

export async function getThread(threadId: string) {
  return prisma.assistantThread.findFirst({
    where: { id: threadId, workspaceId: DEFAULT_WORKSPACE_ID },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      actions: { orderBy: { createdAt: "asc" } },
    },
  });
}

/** The model's history, rebuilt from what it actually saw and said. */
export function historyFromEvents(events: Array<{ kind: string; content: unknown }>): InlineMessage[] {
  const out: InlineMessage[] = [];
  for (const e of events) {
    const text = (e.content as EventContent | null)?.text ?? "";
    if (e.kind === "user" || e.kind === "tool_result" || e.kind === "watch_report") {
      out.push({ role: "user", content: text } as InlineMessage);
    } else if (e.kind === "assistant" || e.kind === "tool_call" || e.kind === "action") {
      out.push({ role: "assistant", content: text } as InlineMessage);
    }
  }
  return out;
}

async function addEvent(threadId: string, kind: EventKind, content: EventContent) {
  return prisma.assistantEvent.create({
    data: { threadId, kind, content: content as unknown as Prisma.InputJsonValue },
  });
}

function threadScopes(thread: { scopes: unknown }): Scope[] {
  const raw = Array.isArray(thread.scopes) ? (thread.scopes as string[]) : [];
  return raw.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
}

async function threadTools(thread: { scopes: unknown; projectId: string | null }, deps: AssistantDeps) {
  return [...mcpTools(threadScopes(thread), deps.ctx()), ...(thread.projectId ? contextTools(thread.projectId) : [])];
}

async function agentFor(thread: { projectId: string | null }, tools: LoopTool[], deps: AssistantDeps) {
  const project = thread.projectId
    ? await prisma.project.findUnique({ where: { id: thread.projectId }, select: { name: true } })
    : null;
  return deps.defineAgent({
    name: "nexus-assistant",
    instructions: INSTRUCTIONS.replace("{{FOCUS}}", focusLine(thread.projectId, project?.name ?? null)).replace(
      "{{TOOLS}}",
      renderToolCatalog(tools),
    ),
    workspaceId: DEFAULT_WORKSPACE_ID,
  });
}

/**
 * Store what a loop run did: each read tool as a call + result, then either
 * the reply or the write it asked for (as a pending action).
 */
async function persistLoop(threadId: string, turn: LoopResult) {
  const created: string[] = [];
  // The loop's history holds the verbatim exchange; pair each tool call's raw
  // request with the TOOL_RESULT the model then saw.
  for (const call of turn.toolCalls) {
    const request = "```json\n" + JSON.stringify({ tool: call.tool, args: call.args }) + "\n```";
    created.push((await addEvent(threadId, "tool_call", { text: request, tool: call.tool, args: call.args })).id);
    created.push(
      (
        await addEvent(threadId, "tool_result", {
          text: toolResultMessage(call.tool, call.result),
          tool: call.tool,
          result: call.result,
        })
      ).id,
    );
  }
  if (turn.pending) {
    const summary = summarizeAction(turn.pending.tool, turn.pending.args);
    const action = await prisma.assistantAction.create({
      data: {
        threadId,
        tool: turn.pending.tool,
        args: turn.pending.args as Prisma.InputJsonValue,
        summary,
      },
    });
    created.push(
      (
        await addEvent(threadId, "action", {
          text: turn.raw,
          tool: turn.pending.tool,
          args: turn.pending.args,
          actionId: action.id,
          summary,
        })
      ).id,
    );
  } else {
    created.push((await addEvent(threadId, "assistant", { text: turn.raw })).id);
  }
  await prisma.assistantThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } });
  return created;
}

export class AssistantError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** One user message: run the loop, keep what happened. */
export async function runThreadTurn(
  threadId: string,
  message: string,
  opts: { context?: { projectId?: string | null } } = {},
  deps: AssistantDeps = defaultAssistantDeps(),
) {
  const thread = await getThread(threadId);
  if (!thread) throw new AssistantError("Thread not found", 404);
  if (thread.actions.some((a) => a.status === "pending" || a.status === "running")) {
    throw new AssistantError("An action is waiting for your decision — run or cancel it first.", 409);
  }
  // The page the message was sent from moves the thread's focus.
  if (opts.context && opts.context.projectId !== undefined && opts.context.projectId !== thread.projectId) {
    await prisma.assistantThread.update({ where: { id: threadId }, data: { projectId: opts.context.projectId } });
    thread.projectId = opts.context.projectId ?? null;
  }
  if (!thread.title) {
    await prisma.assistantThread.update({ where: { id: threadId }, data: { title: message.trim().slice(0, 80) } });
  }

  const history = historyFromEvents(thread.events);
  await addEvent(threadId, "user", { text: message, context: opts.context });
  const tools = await threadTools(thread, deps);
  const agent = await agentFor(thread, tools, deps);
  try {
    const turn = await runToolLoop({ agent, tools, message, history });
    await persistLoop(threadId, turn);
  } catch (err) {
    await addEvent(threadId, "error", { text: err instanceof Error ? err.message : String(err) });
  }
  return getThread(threadId);
}

/** Run an approved write, record its result, and let the assistant react. */
export async function approveAction(threadId: string, actionId: string, deps: AssistantDeps = defaultAssistantDeps()) {
  const thread = await getThread(threadId);
  if (!thread) throw new AssistantError("Thread not found", 404);
  const action = thread.actions.find((a) => a.id === actionId);
  if (!action) throw new AssistantError("Action not found", 404);
  // Claimed atomically: two clicks, or two tabs, must not run it twice.
  const claimed = await prisma.assistantAction.updateMany({
    where: { id: actionId, status: "pending" },
    data: { status: "running", decidedAt: new Date() },
  });
  if (claimed.count === 0) throw new AssistantError(`This action is already ${action.status}.`, 409);

  const tools = await threadTools(thread, deps);
  const tool = tools.find((t) => t.name === action.tool);
  const result = tool
    ? await tool.run(action.args as Record<string, unknown>)
    : { error: `${action.tool} is no longer available to this thread` };
  const failed = !!(result && typeof result === "object" && "error" in result);
  await prisma.assistantAction.update({
    where: { id: actionId },
    data: { status: failed ? "failed" : "done", result: (result ?? null) as Prisma.InputJsonValue },
  });
  const message = toolResultMessage(action.tool, result);
  const history = historyFromEvents(thread.events);
  await addEvent(threadId, "tool_result", { text: message, tool: action.tool, result, actionId });

  const agent = await agentFor(thread, tools, deps);
  try {
    const turn = await runToolLoop({ agent, tools, message, history });
    await persistLoop(threadId, turn);
  } catch (err) {
    await addEvent(threadId, "error", { text: err instanceof Error ? err.message : String(err) });
  }
  return getThread(threadId);
}

/** Decline a write. Recorded for the model; no new turn — the user speaks next. */
export async function cancelAction(threadId: string, actionId: string) {
  const claimed = await prisma.assistantAction.updateMany({
    where: { id: actionId, threadId, status: "pending" },
    data: { status: "cancelled", decidedAt: new Date() },
  });
  if (claimed.count === 0) throw new AssistantError("No pending action to cancel.", 409);
  const action = await prisma.assistantAction.findUniqueOrThrow({ where: { id: actionId } });
  await addEvent(threadId, "tool_result", {
    text: toolResultMessage(action.tool, { cancelled: "The user declined this action. It did not run." }),
    tool: action.tool,
    result: { cancelled: true },
    actionId,
  });
  return getThread(threadId);
}

export async function deleteThread(threadId: string) {
  const res = await prisma.assistantThread.deleteMany({ where: { id: threadId, workspaceId: DEFAULT_WORKSPACE_ID } });
  if (res.count === 0) throw new AssistantError("Thread not found", 404);
}
