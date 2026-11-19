/**
 * Watches (spec 30 phase 3): the assistant keeps an eye on a task or a
 * sandbox it started, and says so in the thread when it happens — the task
 * finished or is blocked on a question, the sandbox came up or failed.
 *
 * There is no poller. `lib/notify.ts` already fans every task and sandbox
 * state change out to Telegram and Slack; the assistant is one more medium
 * there. Each change checks the open watches on that target, and a met one
 * becomes a `watch_report` event plus one short assistant turn — reads only,
 * so a report can look things up (the task's logs) but never act.
 */

import { Prisma, prisma } from "@nexux/db";

import { createMcpContext } from "@/lib/mcp-context";
import type { LoopTool } from "./loop";
import type { AssistantDeps } from "./threads";

export type WatchKind = "task" | "sandbox";
export type WatchUntil = "finished" | "needs_input" | "running" | "any_change";

const WATCH_TTL_MS = 24 * 3600_000;
const TASK_DONE = new Set(["completed", "error", "canceled"]);
const SANDBOX_SETTLED = new Set(["running", "error", "destroyed", "paused"]);

type TaskState = { status: string; needsInput: boolean; [k: string]: unknown };
type SandboxState = { status: string; [k: string]: unknown };

async function stateOf(kind: WatchKind, id: string): Promise<TaskState | SandboxState | null> {
  if (kind === "task") return (await createMcpContext().getTask(id)) as TaskState | null;
  const s = await prisma.sandbox.findUnique({
    where: { id },
    select: { id: true, name: true, status: true, error: true, provider: true, region: true, previewUrl: true },
  });
  return s ? { ...s, runsOn: s.provider === "local" ? s.region : `${s.provider} ${s.region}` } : null;
}

/**
 * Whether a watch has something to report. `finished` also fires when a task
 * blocks on a question: it will not finish until the user answers, and a
 * silent watch is the worst answer to "tell me when it's done".
 */
export function watchMet(kind: WatchKind, until: WatchUntil, state: TaskState | SandboxState): boolean {
  if (until === "any_change") return true;
  if (kind === "task") {
    const t = state as TaskState;
    if (until === "needs_input") return t.needsInput;
    if (until === "finished") return TASK_DONE.has(t.status) || t.needsInput;
    return false;
  }
  if (until === "running") return SANDBOX_SETTLED.has(state.status);
  if (until === "finished") return state.status === "destroyed" || state.status === "error";
  return false;
}

/** The context tool: start watching. Observing changes nothing, so no approval. */
export function watchTool(threadId: string): LoopTool {
  return {
    name: "watch",
    description:
      "Keep an eye on a task or sandbox after this turn; you are told here when it happens. task: until finished (done, failed, or blocked on a question) or needs_input. sandbox: until running (up, or failed). Expires in 24 h.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["task", "sandbox"] },
        id: { type: "string", description: "The task or sandbox id." },
        until: { type: "string", enum: ["finished", "needs_input", "running", "any_change"] },
      },
      required: ["kind", "id", "until"],
      additionalProperties: false,
    },
    kind: "read",
    run: async (args) => {
      const kind = args.kind === "task" || args.kind === "sandbox" ? args.kind : null;
      const until = ["finished", "needs_input", "running", "any_change"].includes(String(args.until))
        ? (args.until as WatchUntil)
        : null;
      const id = typeof args.id === "string" ? args.id : "";
      if (!kind || !until || !id) return { error: "kind (task|sandbox), id and until are required" };
      const state = await stateOf(kind, id);
      if (!state) return { error: `No ${kind} ${id}` };
      // Already there: say so now rather than wait for a change that came and went.
      if (until !== "any_change" && watchMet(kind, until, state)) return { alreadyHappened: true, state };
      const watch = await prisma.assistantWatch.create({
        data: { threadId, kind, targetId: id, until, expiresAt: new Date(Date.now() + WATCH_TTL_MS) },
      });
      return { watching: true, watchId: watch.id, until, expiresAt: watch.expiresAt.toISOString(), state };
    },
  };
}

export async function cancelWatch(threadId: string, watchId: string): Promise<boolean> {
  const res = await prisma.assistantWatch.updateMany({
    where: { id: watchId, threadId, status: "open" },
    data: { status: "cancelled" },
  });
  return res.count > 0;
}

/**
 * Called by lib/notify.ts on every state change of a task or sandbox. Never
 * throws: a report that cannot be written must not fail the run behind it.
 */
export async function fireAssistantWatches(
  kind: WatchKind,
  targetId: string,
  deps?: AssistantDeps,
): Promise<void> {
  try {
    await prisma.assistantWatch.updateMany({
      where: { kind, targetId, status: "open", expiresAt: { lt: new Date() } },
      data: { status: "expired" },
    });
    const open = await prisma.assistantWatch.findMany({ where: { kind, targetId, status: "open" } });
    if (open.length === 0) return;
    const state = await stateOf(kind, targetId);
    if (!state) return;
    for (const watch of open) {
      if (!watchMet(kind, watch.until as WatchUntil, state)) continue;
      // Claimed once: two notifications racing must not report twice.
      const claimed = await prisma.assistantWatch.updateMany({
        where: { id: watch.id, status: "open" },
        data: { status: watch.until === "any_change" ? "open" : "fired" },
      });
      if (claimed.count === 0) continue;
      await reportToThread(watch.threadId, kind, targetId, watch.until, state, deps);
    }
  } catch (err) {
    console.error("[assistant] watch report failed:", err);
  }
}

/** The report, then one short turn — reads only — so it reads as a reply. */
export async function reportToThread(
  threadId: string,
  kind: WatchKind,
  targetId: string,
  until: string,
  state: unknown,
  deps?: AssistantDeps,
) {
  const { addEvent, agentFor, defaultAssistantDeps, getThread, historyFromEvents, loopAndPersist, threadTools } =
    await import("./threads");
  const thread = await getThread(threadId);
  if (!thread) return;
  const text = `WATCH_REPORT ${kind} ${targetId} (until ${until}): ${JSON.stringify(state)}\nTell the user what happened, briefly — the outcome, a PR link if there is one, or the question it is blocked on. Look things up if that helps; do not start anything.`;
  const history = historyFromEvents(thread.events);
  await addEvent(threadId, "watch_report", { text, tool: kind, args: { id: targetId, until }, result: state as Prisma.JsonValue });
  const d = deps ?? defaultAssistantDeps();
  const tools = (await threadTools(thread, d)).filter((t) => t.kind === "read");
  const agent = await agentFor(thread, tools, d);
  await loopAndPersist(threadId, { agent, tools, message: text, history });
}
