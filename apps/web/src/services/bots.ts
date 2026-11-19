// Client fetchers for /api/bots (spec 31).

import type { MailDraft } from "@/lib/bot-mail";
import type { BotShape } from "@/lib/bot-shapes";

export type BotActivity = "off" | "starting" | "idle" | "working" | "error";

export type Bot = {
  id: string;
  name: string;
  role: string | null;
  instructions: string;
  color: string;
  shape: BotShape;
  model: string | null;
  /** Its own MCP servers (Claude Code's native mcpServers shape), or null. */
  mcpServers: Record<string, Record<string, unknown>> | null;
  claudeCredentialId: string | null;
  idleMinutes: number;
  createdAt: string;
  updatedAt: string;
};

export type BotListItem = Bot & {
  activity: BotActivity;
  lastActivityAt: string | null;
  /** Latest message, one line — the chat-list preview. */
  preview: string | null;
  previewAt: string | null;
  needsInput: boolean;
};

export type BotStep = { app: string; action: string; detail: string | null };

export type BotSession = {
  id: string;
  status: "starting" | "ready" | "stopped" | "error";
  error: string | null;
  /** Bare embedded screen, view-only until control is handed over (postMessage). */
  vncUrl: string | null;
  /** Full noVNC with clipboard and extra keys, for a new tab. */
  vncFullUrl: string | null;
  /** Boot progress while `starting` (image build step, waiting for the desktop). */
  progress: string | null;
  createdAt: string;
  stoppedAt: string | null;
  lastActivityAt: string;
};

export type BotRun = {
  id: string;
  sessionId: string;
  prompt: string;
  status: "queued" | "running" | "completed" | "error" | "canceled";
  result: string | null;
  needsInput: boolean;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  logTail: string | null;
  steps: BotStep[];
  /** JSON MailState: what you did with each email card in the reply. */
  mailState: string | null;
};

export type BotRoutine = {
  id: string;
  botId: string;
  name: string;
  prompt: string;
  cron: string;
  /** The schedule in words: "Every Monday around 8:00 AM". */
  label: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
};

export type BotRoutineInput = { name: string; prompt: string; cron: string; enabled?: boolean };

/** A teammate's side of a handoff, threaded under the sender's message. */
export type BotThreadReply = {
  id: string;
  botId: string;
  sourceRunId: string;
  status: BotRun["status"];
  text: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type BotFeed = {
  bot: Bot;
  session: BotSession | null;
  runs: BotRun[];
  routines: BotRoutine[];
  threads: BotThreadReply[];
};

export type BotInput = {
  name: string;
  role?: string | null;
  instructions?: string;
  color?: string;
  shape?: BotShape;
  model?: string | null;
  idleMinutes?: number;
  mcpServers?: Record<string, Record<string, unknown>> | null;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: unknown }).error;
    throw new Error(typeof err === "string" ? err : `Request failed (${res.status})`);
  }
  return body as T;
}

export const getBots = () => call<BotListItem[]>("/api/bots");

export const createBot = (input: BotInput) =>
  call<Bot>("/api/bots", { method: "POST", body: JSON.stringify(input) });

export const updateBot = (id: string, input: Partial<BotInput>) =>
  call<Bot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(input) });

export const deleteBot = (id: string) => call<{ ok: true }>(`/api/bots/${id}`, { method: "DELETE" });

export const getBotFeed = (id: string) => call<BotFeed>(`/api/bots/${id}/runs`);

export const sendBotPrompt = (id: string, prompt: string) =>
  call<BotRun>(`/api/bots/${id}/runs`, { method: "POST", body: JSON.stringify({ prompt }) });

/** Act on an email card in a reply: send it (or save a Gmail draft) as edited, or discard it. */
export const actOnBotMail = (
  id: string,
  runId: string,
  body: { index: number; action: "send" | "draft" | "discard"; mail?: MailDraft },
) => call<{ ok: true }>(`/api/bots/${id}/runs/${runId}/mail`, { method: "POST", body: JSON.stringify(body) });

export const cancelBotRun = (id: string, runId: string) =>
  call<{ ok: true }>(`/api/bots/${id}/runs/${runId}`, { method: "DELETE" });

export const startBotComputer = (id: string) =>
  call<BotSession>(`/api/bots/${id}/session`, { method: "POST" });

export const stopBotComputer = (id: string) =>
  call<{ ok: true }>(`/api/bots/${id}/session`, { method: "DELETE" });

/** Keeps the computer awake while its screen is open. */
export const touchBotComputer = (id: string) =>
  call<{ ok: boolean }>(`/api/bots/${id}/session`, { method: "PATCH" });

export const createBotRoutine = (botId: string, input: BotRoutineInput) =>
  call<BotRoutine>(`/api/bots/${botId}/routines`, { method: "POST", body: JSON.stringify(input) });

export const updateBotRoutine = (botId: string, id: string, input: Partial<BotRoutineInput>) =>
  call<BotRoutine>(`/api/bots/${botId}/routines/${id}`, { method: "PATCH", body: JSON.stringify(input) });

export const deleteBotRoutine = (botId: string, id: string) =>
  call<{ ok: true }>(`/api/bots/${botId}/routines/${id}`, { method: "DELETE" });

export const runBotRoutine = (botId: string, id: string) =>
  call<BotRun>(`/api/bots/${botId}/routines/${id}/run`, { method: "POST" });
