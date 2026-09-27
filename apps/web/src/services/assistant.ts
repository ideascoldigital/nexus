/** Global assistant (spec 30) — client service for /api/assistant/threads. */

export type AssistantEventKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "action"
  | "watch_report"
  | "error";

export type AssistantEvent = {
  id: string;
  kind: AssistantEventKind;
  content: {
    text: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: unknown;
    actionId?: string;
    summary?: string;
    context?: { projectId?: string | null };
  };
  createdAt: string;
};

export type AssistantAction = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  result: unknown;
  createdAt: string;
  decidedAt: string | null;
};

export type AssistantThreadSummary = {
  id: string;
  title: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AssistantThread = AssistantThreadSummary & {
  events: AssistantEvent[];
  actions: AssistantAction[];
};

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : `Request failed (${res.status})`);
  }
  return body as T;
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

export async function listAssistantThreads(): Promise<AssistantThreadSummary[]> {
  return (await json<{ threads: AssistantThreadSummary[] }>(await fetch("/api/assistant/threads"))).threads;
}

export async function createAssistantThread(projectId: string | null): Promise<AssistantThreadSummary> {
  return json(await post("/api/assistant/threads", { projectId }));
}

export async function getAssistantThread(threadId: string): Promise<AssistantThread> {
  return json(await fetch(`/api/assistant/threads/${threadId}`));
}

export async function sendAssistantMessage(
  threadId: string,
  message: string,
  projectId: string | null,
): Promise<AssistantThread> {
  return json(await post(`/api/assistant/threads/${threadId}/turn`, { message, context: { projectId } }));
}

export async function decideAssistantAction(
  threadId: string,
  actionId: string,
  decision: "approve" | "cancel",
): Promise<AssistantThread> {
  return json(await post(`/api/assistant/threads/${threadId}/actions/${actionId}/${decision}`));
}

export async function deleteAssistantThread(threadId: string): Promise<void> {
  const res = await fetch(`/api/assistant/threads/${threadId}`, { method: "DELETE" });
  if (!res.ok) await json(res);
}
