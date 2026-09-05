// Telegram bot integration: task/sandbox notifications + remote control.
//
// Local-first friendly: a long-polling loop (getUpdates) instead of a webhook,
// so no public URL is needed. The bot token lives in Settings
// (telegram_bot_token), resolved workspace-aware like Slack's: a project's
// notifications prefer its workspace's token, the bare key is the fallback.
// The chat is resolved per project — SandboxConfig.telegramChatId first
// (e.g. one Telegram group per project), falling back to the
// telegram_chat_id setting. Everything no-ops when nothing is configured.
//
// Remote control works by replying on the phone:
//   - notifications carry a #task_<id> tag  -> replying sends a follow-up
//     (same branch, same PR, resumed Claude session)
//   - sandbox-ready messages carry #sandbox_<id> -> replying starts a new task
// Commands: /tasks, /sandboxes, /help — scoped to the chat's project (the
// global chat sees every project). /start echoes the chat id so a new chat or
// group can be wired up by pasting it into Settings or the project's sandbox
// settings.

import fs from "fs";
import path from "path";
import { prisma } from "@nexux/db";
import { findSetting, workspaceIdOfProject } from "@/lib/workspace";

const API = "https://api.telegram.org";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    reply_to_message?: { message_id: number; text?: string };
  };
};

/** Chat routing table: chat id -> project scope (null = global, all projects). */
type ChatRoutes = Map<string, string | null>;

async function getBotToken(
  workspaceId?: string | null,
): Promise<string | null> {
  return findSetting("telegram_bot_token", workspaceId);
}

// getMe result cache — the bot username backs the t.me deep links and only
// changes if the token does.
let botUsernameCache: { token: string; username: string | null } | null = null;

/** The bot's @username (no token leaves the server) — null if unconfigured. */
export async function getBotUsername(): Promise<string | null> {
  const token = await getBotToken();
  if (!token) return null;
  if (botUsernameCache?.token === token) return botUsernameCache.username;
  const me = (await callApi(token, "getMe", {})) as { username?: string } | null;
  const username = me?.username ?? null;
  botUsernameCache = { token, username };
  return username;
}

/** Health-strip check: a bot token plus at least one routable chat. */
export async function isTelegramConfigured(): Promise<boolean> {
  const token = await getBotToken();
  if (!token) return false;
  if (await getGlobalChatId()) return true;
  const projectChat = await prisma.sandboxConfig.findFirst({
    where: { NOT: { telegramChatId: null } },
    select: { projectId: true },
  });
  return projectChat !== null;
}

async function getGlobalChatId(
  workspaceId?: string | null,
): Promise<string | null> {
  return findSetting("telegram_chat_id", workspaceId);
}

/** The chat a project's notifications go to: its own chat, else the global one. */
async function resolveProjectChatId(
  projectId: string,
  workspaceId?: string | null,
): Promise<string | null> {
  const cfg = await prisma.sandboxConfig.findUnique({
    where: { projectId },
    select: { telegramChatId: true },
  });
  return cfg?.telegramChatId?.trim() || (await getGlobalChatId(workspaceId));
}

async function getChatRoutes(): Promise<ChatRoutes> {
  const routes: ChatRoutes = new Map();
  const configs = await prisma.sandboxConfig.findMany({
    where: { NOT: { telegramChatId: null } },
    select: { projectId: true, telegramChatId: true },
  });
  for (const c of configs) {
    if (c.telegramChatId?.trim()) routes.set(c.telegramChatId.trim(), c.projectId);
  }
  // Global chat last so it wins over a project accidentally using the same id.
  const global = await getGlobalChatId();
  if (global) routes.set(global, null);
  return routes;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function callApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: unknown;
      error_code?: number;
      description?: string;
    };
    if (!json.ok) {
      // e.g. "chat not found" for a mistyped chat id — surface it, or a lost
      // notification is undiagnosable. Never log the token.
      console.error(
        `[telegram] ${method} failed${"chat_id" in body ? ` (chat ${body.chat_id})` : ""}: ${json.error_code ?? "?"} ${json.description ?? "unknown error"}`,
      );
      return null;
    }
    return json.result ?? null;
  } catch (err) {
    console.error(`[telegram] ${method} request failed:`, err);
    return null;
  }
}

/** Send an HTML-formatted message to one chat. No-op without a token. */
export async function sendTelegramMessage(
  html: string,
  chatId: string,
  token?: string | null,
): Promise<boolean> {
  const botToken = token ?? (await getBotToken());
  if (!botToken || !chatId) return false;
  const result = await callApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  return result !== null;
}

/**
 * Send local image files to a chat as photos (album for 2+, max 10). Used to
 * push a task's collected screenshots to Telegram alongside the text
 * notification.
 */
export async function sendTelegramPhotos(
  chatId: string,
  files: string[],
  caption?: string,
  token?: string | null,
): Promise<boolean> {
  const botToken = token ?? (await getBotToken());
  if (!botToken || !chatId || files.length === 0) return false;
  const batch = files.slice(0, 10);
  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    let method: string;
    if (batch.length === 1) {
      method = "sendPhoto";
      if (caption) form.append("caption", caption);
      form.append(
        "photo",
        new Blob([fs.readFileSync(batch[0])]),
        path.basename(batch[0]),
      );
    } else {
      method = "sendMediaGroup";
      form.append(
        "media",
        JSON.stringify(
          batch.map((f, i) => ({
            type: "photo",
            media: `attach://p${i}`,
            ...(i === 0 && caption ? { caption } : {}),
          })),
        ),
      );
      batch.forEach((f, i) =>
        form.append(`p${i}`, new Blob([fs.readFileSync(f)]), path.basename(f)),
      );
    }
    const res = await fetch(`${API}/bot${botToken}/${method}`, {
      method: "POST",
      body: form,
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      console.error(
        `[telegram] ${method} failed (chat ${chatId}): ${json.description ?? "unknown error"}`,
      );
    }
    return json.ok;
  } catch (err) {
    console.error("[telegram] photo send failed:", err);
    return false;
  }
}

/** A task's collected screenshots (if any) as absolute local paths. */
async function taskScreenshotFiles(taskId: string): Promise<string[]> {
  // Lazy import: task-manager statically imports this module.
  const { taskScreenshotDir } = await import("./task-manager");
  const dir = taskScreenshotDir(taskId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "";
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Notify the owning project's chat that a task finished (completed or error). */
export async function notifyTaskFinished(taskId: string): Promise<void> {
  const task = await prisma.sandboxTask.findUnique({
    where: { id: taskId },
    include: { sandbox: true, feature: true },
  });
  if (!task) return;
  if (task.sandbox.muteTelegram) return;
  const ws = await workspaceIdOfProject(task.sandbox.projectId);
  const chatId = await resolveProjectChatId(task.sandbox.projectId, ws);
  const token = await getBotToken(ws);
  if (!chatId || !token) return;

  const ok = task.status === "completed";
  const title = task.feature?.title ?? task.prompt.slice(0, 80);
  const lines = [
    `${ok ? "✅" : "❌"} <b>${escapeHtml(title)}</b>`,
    `Sandbox: <code>${escapeHtml(task.sandbox.name)}</code>`,
  ];
  if (!ok && task.error) lines.push(`Error: ${escapeHtml(task.error.slice(0, 300))}`);
  if (ok && task.result) {
    lines.push("", escapeHtml(task.result.slice(0, 500)));
  }
  const meta: string[] = [];
  const dur = formatDuration(task.durationMs);
  if (dur) meta.push(dur);
  if (task.costUsd) meta.push(`$${task.costUsd.toFixed(2)}`);
  if (meta.length) lines.push("", meta.join(" · "));
  if (task.prUrl) lines.push(`PR: ${task.prUrl}`);
  if (task.previewUrl) lines.push(`Preview: ${task.previewUrl}`);
  lines.push("", `↩️ Reply to continue this task. #task_${task.id}`);

  await sendTelegramMessage(lines.join("\n"), chatId, token);

  const shots = await taskScreenshotFiles(task.id).catch(() => []);
  if (shots.length > 0) {
    await sendTelegramPhotos(chatId, shots, `📸 ${title.slice(0, 200)}`, token);
  }
}

/**
 * Dev-console prompts: finished (💬), asking for direction (🙋), or failed
 * (⚠️). Respects the sandbox's Telegram mute so working from the UI doesn't
 * double-notify; replying to the message queues the next prompt.
 */
export async function notifyDevTask(taskId: string): Promise<void> {
  const task = await prisma.sandboxTask.findUnique({
    where: { id: taskId },
    include: { sandbox: true },
  });
  if (!task || task.kind !== "dev") return;
  if (task.sandbox.muteTelegram) return;
  const ws = await workspaceIdOfProject(task.sandbox.projectId);
  const chatId = await resolveProjectChatId(task.sandbox.projectId, ws);
  const token = await getBotToken(ws);
  if (!chatId || !token) return;

  const needsInput = task.phase === "needs_input";
  const ok = task.status === "completed";
  const icon = !ok ? "⚠️" : needsInput ? "🙋" : "💬";
  const lines = [
    `${icon} <b>${escapeHtml(task.prompt.slice(0, 80))}</b>`,
    `Dev sandbox: <code>${escapeHtml(task.sandbox.name)}</code>${needsInput ? " · needs your input" : ""}`,
  ];
  if (!ok && task.error) {
    lines.push(`Error: ${escapeHtml(task.error.slice(0, 300))}`);
  }
  if (ok && task.result) {
    lines.push("", escapeHtml(task.result.slice(0, 700)));
  }
  const meta: string[] = [];
  const dur = formatDuration(task.durationMs);
  if (dur) meta.push(dur);
  if (task.costUsd) meta.push(`$${task.costUsd.toFixed(2)}`);
  if (meta.length) lines.push("", meta.join(" · "));
  lines.push("", `↩️ Reply to send the next prompt. #task_${task.id}`);

  await sendTelegramMessage(lines.join("\n"), chatId, token);

  const shots = await taskScreenshotFiles(task.id).catch(() => []);
  if (shots.length > 0) {
    await sendTelegramPhotos(chatId, shots, `📸 ${task.prompt.slice(0, 200)}`, token);
  }
}

/** Notify the owning project's chat that a sandbox provisioned or failed. */
export async function notifySandboxStatus(sandboxId: string): Promise<void> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) return;
  if (sandbox.muteTelegram) return;
  const ws = await workspaceIdOfProject(sandbox.projectId);
  const chatId = await resolveProjectChatId(sandbox.projectId, ws);
  const token = await getBotToken(ws);
  if (!chatId || !token) return;

  if (sandbox.status === "running") {
    const lines = [
      `🚀 Sandbox <code>${escapeHtml(sandbox.name)}</code> is ready`,
      `${sandbox.size} @ ${sandbox.region}${sandbox.publicIp ? ` · ${sandbox.publicIp}` : ""}`,
      "",
      `↩️ Reply with a prompt to run a task on it. #sandbox_${sandbox.id}`,
    ];
    await sendTelegramMessage(lines.join("\n"), chatId, token);
  } else if (sandbox.status === "error") {
    await sendTelegramMessage(
      `❌ Sandbox <code>${escapeHtml(sandbox.name)}</code> failed to provision:\n${escapeHtml((sandbox.error ?? "unknown error").slice(0, 300))}`,
      chatId,
      token,
    );
  }
}

// ---------------------------------------------------------------------------
// Remote control (long-polling loop)
// ---------------------------------------------------------------------------

const TAG_TASK = /#task_([a-z0-9]+)/i;
const TAG_SANDBOX = /#sandbox_([a-z0-9]+)/i;

/**
 * scopeProjectId null = the global chat: may act on every project. Shared
 * with the Slack socket — same tags, same routing; the return string is
 * Telegram HTML (the Slack side converts it to mrkdwn).
 */
export async function handleReply(
  scopeProjectId: string | null,
  repliedText: string,
  prompt: string,
): Promise<string> {
  // Lazy imports: task-manager also imports this module for notifications.
  const { createTask } = await import("./task-manager");
  const { enqueueDevPrompt } = await import("./dev-console");

  const taskTag = repliedText.match(TAG_TASK);
  if (taskTag) {
    const parent = await prisma.sandboxTask.findUnique({
      where: { id: taskTag[1] },
      include: { sandbox: true },
    });
    if (!parent) return "Task not found — it may have been deleted.";
    if (scopeProjectId && parent.sandbox.projectId !== scopeProjectId) {
      return "That task belongs to another project's chat.";
    }
    // Replying in a dev-console thread queues the next prompt on the same
    // continuous session — no follow-up/PR ceremony.
    if (parent.kind === "dev") {
      try {
        await enqueueDevPrompt(
          parent.sandbox.projectId,
          parent.sandboxId,
          prompt,
        );
        return `💬 Prompt queued on <code>${escapeHtml(parent.sandbox.name)}</code> — I'll message you when Claude answers.`;
      } catch (err) {
        return `⚠️ ${escapeHtml(err instanceof Error ? err.message : "Could not queue the prompt")}`;
      }
    }
    try {
      await createTask({
        projectId: parent.sandbox.projectId,
        sandboxId: parent.sandboxId,
        prompt,
        followUpOf: parent.id,
      });
      return `🔄 Follow-up started on <code>${escapeHtml(parent.sandbox.name)}</code> — I'll message you when it finishes.`;
    } catch (err) {
      return `⚠️ ${escapeHtml(err instanceof Error ? err.message : "Could not start the follow-up")}`;
    }
  }

  const sandboxTag = repliedText.match(TAG_SANDBOX);
  if (sandboxTag) {
    const sandbox = await prisma.sandbox.findUnique({
      where: { id: sandboxTag[1] },
    });
    if (!sandbox) return "Sandbox not found — it may have been destroyed.";
    if (scopeProjectId && sandbox.projectId !== scopeProjectId) {
      return "That sandbox belongs to another project's chat.";
    }
    if (sandbox.dedicated) {
      try {
        await enqueueDevPrompt(sandbox.projectId, sandbox.id, prompt);
        return `💬 Prompt queued on dev sandbox <code>${escapeHtml(sandbox.name)}</code>.`;
      } catch (err) {
        return `⚠️ ${escapeHtml(err instanceof Error ? err.message : "Could not queue the prompt")}`;
      }
    }
    try {
      await createTask({
        projectId: sandbox.projectId,
        sandboxId: sandbox.id,
        prompt,
      });
      return `▶️ Task started on <code>${escapeHtml(sandbox.name)}</code> — I'll message you when it finishes.`;
    } catch (err) {
      return `⚠️ ${escapeHtml(err instanceof Error ? err.message : "Could not start the task")}`;
    }
  }

  return "Reply to a task or sandbox notification to act on it, or use /help.";
}

async function handleCommand(
  scopeProjectId: string | null,
  text: string,
): Promise<string> {
  if (text.startsWith("/tasks")) {
    const tasks = await prisma.sandboxTask.findMany({
      where: scopeProjectId
        ? { sandbox: { projectId: scopeProjectId } }
        : undefined,
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { sandbox: true, feature: true },
    });
    if (tasks.length === 0) return "No tasks yet.";
    return tasks
      .map((t) => {
        const icon =
          t.status === "completed" ? "✅" : t.status === "error" ? "❌" : "⏳";
        const title = t.feature?.title ?? t.prompt.slice(0, 60);
        return `${icon} <b>${escapeHtml(title)}</b>\n<code>${escapeHtml(t.sandbox.name)}</code> · ${t.status} #task_${t.id}`;
      })
      .join("\n\n");
  }

  if (text.startsWith("/sandboxes")) {
    const sandboxes = await prisma.sandbox.findMany({
      where: {
        status: { notIn: ["destroyed"] },
        archived: false,
        ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    if (sandboxes.length === 0) return "No active sandboxes.";
    return sandboxes
      .map(
        (s) =>
          `${s.status === "running" ? "🟢" : "🟡"} <code>${escapeHtml(s.name)}</code> · ${s.status}${s.status === "running" ? ` #sandbox_${s.id}` : ""}`,
      )
      .join("\n");
  }

  const scopeNote = scopeProjectId
    ? "This chat is scoped to one project."
    : "This chat sees every project.";
  return [
    "<b>Nexus bot</b>",
    "• Reply to a ✅/❌ task message → follow-up on that task",
    "• Reply to a 🚀 sandbox message → new task on that sandbox",
    "• /tasks — recent tasks (reply-able)",
    "• /sandboxes — active sandboxes (reply-able)",
    scopeNote,
  ].join("\n");
}

async function handleUpdate(
  token: string,
  routes: ChatRoutes,
  update: TelegramUpdate,
) {
  const msg = update.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return;

  const chatKey = String(msg.chat.id);

  // "Create/link group" flow: the t.me/<bot>?startgroup=<projectId> deep link
  // makes Telegram add the bot to a (possibly brand-new) group and post
  // "/start <projectId>" — wire that chat to the project automatically.
  const start = text.match(/^\/start(?:@\S+)?(?:\s+(\S+))?/);
  if (start?.[1]) {
    const project = await prisma.project.findUnique({
      where: { id: start[1] },
      select: { id: true, name: true },
    });
    if (project) {
      await prisma.sandboxConfig.upsert({
        where: { projectId: project.id },
        update: { telegramChatId: chatKey },
        create: { projectId: project.id, telegramChatId: chatKey },
      });
      await callApi(token, "sendMessage", {
        chat_id: msg.chat.id,
        text: `✅ This chat is now linked to <b>${escapeHtml(project.name)}</b> — its task and sandbox notifications land here, and replies control it. /help for commands.`,
        parse_mode: "HTML",
      });
      return;
    }
  }

  if (!routes.has(chatKey)) {
    // Unknown chat: only answer /start, with the id needed to wire it up
    // (global Settings or a project's sandbox settings). Everything else is
    // ignored — unknown chats get no data and no control.
    if (start) {
      await callApi(token, "sendMessage", {
        chat_id: msg.chat.id,
        text: `This chat's id is <code>${msg.chat.id}</code> — save it as the Telegram Chat ID in Nexus Settings (global) or in a project's sandbox settings to route that project here.`,
        parse_mode: "HTML",
      });
    }
    return;
  }

  const scopeProjectId = routes.get(chatKey) ?? null;
  const reply = msg.reply_to_message?.text
    ? await handleReply(scopeProjectId, msg.reply_to_message.text, text)
    : await handleCommand(scopeProjectId, text);
  await sendTelegramMessage(reply, chatKey, token);
}

// Survives dev-mode hot reloads like the prisma/stack-runner globals.
const globalForTelegram = globalThis as unknown as {
  nexuxTelegramPoller: { running: boolean } | undefined;
};

export function startTelegramPoller(): void {
  if (globalForTelegram.nexuxTelegramPoller?.running) return;
  const state = { running: true };
  globalForTelegram.nexuxTelegramPoller = state;

  void (async () => {
    let offset: number | undefined;
    let announced = false;
    while (state.running) {
      try {
        const token = await getBotToken();
        if (!token) {
          announced = false;
          await sleep(30_000);
          continue;
        }
        if (!announced) {
          console.log("[telegram] poller active");
          announced = true;
        }
        if (offset === undefined) {
          // Skip the backlog on boot so restarts don't replay old commands.
          const last = (await callApi(token, "getUpdates", {
            offset: -1,
            timeout: 0,
          })) as TelegramUpdate[] | null;
          offset = last?.length ? last[last.length - 1].update_id + 1 : 0;
        }
        const updates = (await callApi(token, "getUpdates", {
          offset,
          timeout: 50,
          allowed_updates: ["message"],
        })) as TelegramUpdate[] | null;
        if (!updates) {
          await sleep(5_000);
          continue;
        }
        if (updates.length > 0) {
          const routes = await getChatRoutes();
          for (const update of updates) {
            offset = update.update_id + 1;
            await handleUpdate(token, routes, update);
          }
        }
      } catch (err) {
        console.error("[telegram] poller error:", err);
        await sleep(10_000);
      }
    }
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
