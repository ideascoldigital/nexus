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

export type AssistantWatch = {
  id: string;
  kind: "task" | "sandbox";
  targetId: string;
  until: string;
  status: string;
  expiresAt: string;
};

export type AssistantThread = AssistantThreadSummary & {
  events: AssistantEvent[];
  actions: AssistantAction[];
  /** Open watches only. */
  watches: AssistantWatch[];
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

/**
 * POST and read the answer as Server-Sent Events: `event` frames as each step
 * is stored, then `done` with the whole thread (or `failure`).
 */
async function streamThread(
  url: string,
  body: unknown,
  onEvent: (event: AssistantEvent) => void,
): Promise<AssistantThread> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) return json(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: AssistantThread | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const name = frame.match(/^event: (.*)$/m)?.[1];
      const data = frame.match(/^data: (.*)$/m)?.[1];
      if (!name || !data) continue;
      const payload = JSON.parse(data);
      if (name === "event") onEvent(payload as AssistantEvent);
      else if (name === "done") final = payload as AssistantThread;
      else if (name === "failure") throw new Error((payload as { error: string }).error);
    }
  }
  if (!final) throw new Error("The connection closed before the assistant finished.");
  return final;
}

export function streamAssistantMessage(
  threadId: string,
  message: string,
  projectId: string | null,
  onEvent: (event: AssistantEvent) => void,
): Promise<AssistantThread> {
  return streamThread(`/api/assistant/threads/${threadId}/turn`, { message, context: { projectId } }, onEvent);
}

export function streamApproveAction(
  threadId: string,
  actionId: string,
  onEvent: (event: AssistantEvent) => void,
): Promise<AssistantThread> {
  return streamThread(`/api/assistant/threads/${threadId}/actions/${actionId}/approve`, {}, onEvent);
}

export async function cancelAssistantWatch(threadId: string, watchId: string): Promise<void> {
  const res = await fetch(`/api/assistant/threads/${threadId}/watches/${watchId}`, { method: "DELETE" });
  if (!res.ok) await json(res);
}
