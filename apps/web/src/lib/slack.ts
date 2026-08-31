// Slack integration: the outbound half of the Telegram bot, for channels.
//
// Same shape as telegram.ts on purpose: the bot token is global (Settings:
// slack_bot_token), the channel resolves per project —
// SandboxConfig.slackChannelId first, falling back to the global Settings:
// slack_channel_id — and everything no-ops when nothing is configured.
//
// Inbound (reply-in-thread = follow-up) runs over Socket Mode — an outbound
// WebSocket, so still no public URL; see slack-socket.ts. Notifications carry
// the same #task_/#sandbox_ tags Telegram uses, and channels may be referred
// to by name (#deploys) or id (C0123…) anywhere — names resolve here.

import fs from "fs";
import path from "path";
import { prisma } from "@nexux/db";
import { getWorkspaceSetting, workspaceIdOfProject } from "@/lib/workspace";

const API = "https://slack.com/api";

/**
 * Settings saved from a non-default workspace live under "ws:<id>:<key>"
 * (see workspace.ts) — a bare-key read misses them, which is exactly how the
 * first Slack setup "didn't take". Resolution: the given workspace's value
 * (falling back to the bare key), else ANY workspace's — a local-first
 * install talks to one Slack app, wherever it was configured from.
 */
async function findSetting(
  key: string,
  workspaceId?: string | null,
): Promise<string | null> {
  if (workspaceId) {
    const scoped = await getWorkspaceSetting(workspaceId, key);
    if (scoped) return scoped.value;
  }
  const rows = await prisma.settings.findMany({
    where: { isActive: true, OR: [{ key }, { key: { endsWith: `:${key}` } }] },
    orderBy: { key: "asc" },
  });
  const bare = rows.find((r) => r.key === key);
  return (bare ?? rows[0])?.value ?? null;
}

export async function getBotToken(): Promise<string | null> {
  return findSetting("slack_bot_token");
}

/** App-level token (xapp-…) — what Socket Mode connects with. */
export async function getAppToken(): Promise<string | null> {
  return findSetting("slack_app_token");
}

async function getGlobalChannelRef(
  workspaceId?: string | null,
): Promise<string | null> {
  return findSetting("slack_channel_id", workspaceId);
}

/** Does this look like a channel ID (C…/G…) rather than a name? */
export function isChannelId(ref: string): boolean {
  return /^[CG][A-Z0-9]{6,}$/.test(ref.trim());
}

/** Slack channel-name rules: lowercase, digits, dashes/underscores, ≤80. */
export function normalizeChannelName(name: string): string {
  return name
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/[\s.]+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 80);
}

export type SlackChannel = { id: string; name: string; isMember: boolean };

// conversations.list is paginated and rate-limited — cache it briefly. The
// cache also serves name→id resolution on every send.
let channelCache: { at: number; channels: SlackChannel[] } | null = null;
const CHANNEL_CACHE_MS = 60_000;

/** Channels the bot can see (public + private it's in), cached for a minute. */
export async function listSlackChannels(force = false): Promise<SlackChannel[]> {
  const token = await getBotToken();
  if (!token) return [];
  if (!force && channelCache && Date.now() - channelCache.at < CHANNEL_CACHE_MS) {
    return channelCache.channels;
  }
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = (await callApiGet(token, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    })) as {
      channels?: Array<{ id: string; name: string; is_member?: boolean }>;
      response_metadata?: { next_cursor?: string };
    } | null;
    if (!res?.channels) break;
    for (const c of res.channels) {
      channels.push({ id: c.id, name: c.name, isMember: Boolean(c.is_member) });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  channelCache = { at: Date.now(), channels };
  return channels;
}

/** Create a public channel (name normalized to Slack's rules) and join it. */
export async function createSlackChannel(
  name: string,
): Promise<SlackChannel> {
  const token = await getBotToken();
  if (!token) throw new Error("Slack bot token is not configured");
  const normalized = normalizeChannelName(name);
  if (!normalized) throw new Error("Channel name is empty after normalizing");
  const res = (await callApi(token, "conversations.create", {
    name: normalized,
  })) as { channel?: { id: string; name: string } } | null;
  if (!res?.channel) {
    throw new Error(
      "Could not create the channel — it may already exist, or the token lacks channels:manage",
    );
  }
  channelCache = null; // the new channel must show up on the next list
  return { id: res.channel.id, name: res.channel.name, isMember: true };
}

/** A channel reference (id, name or #name) → id. Null when unresolvable. */
export async function resolveChannelRef(
  ref: string | null | undefined,
): Promise<string | null> {
  const trimmed = ref?.trim();
  if (!trimmed) return null;
  if (isChannelId(trimmed)) return trimmed;
  const name = normalizeChannelName(trimmed);
  const channels = await listSlackChannels();
  const hit = channels.find((c) => c.name === name);
  if (!hit) {
    console.error(
      `[slack] channel "${trimmed}" not found — check the name, and that the bot can see it`,
    );
    return null;
  }
  return hit.id;
}

/** The channel a project's notifications go to: its own, else the global one. */
async function resolveProjectChannelId(
  projectId: string,
): Promise<string | null> {
  const cfg = await prisma.sandboxConfig.findUnique({
    where: { projectId },
    select: { slackChannelId: true },
  });
  return (
    (await resolveChannelRef(cfg?.slackChannelId)) ??
    (await resolveChannelRef(
      await getGlobalChannelRef(await workspaceIdOfProject(projectId)),
    ))
  );
}

/**
 * Routing table for the socket: channel id -> project scope (null = the
 * global channel, which may act on every project).
 */
export async function getSlackRoutes(): Promise<Map<string, string | null>> {
  const routes = new Map<string, string | null>();
  const configs = await prisma.sandboxConfig.findMany({
    where: { NOT: { slackChannelId: null } },
    select: { projectId: true, slackChannelId: true },
  });
  for (const c of configs) {
    const id = await resolveChannelRef(c.slackChannelId);
    if (id) routes.set(id, c.projectId);
  }
  // Global channel last so it wins over a project reusing the same channel.
  const global = await resolveChannelRef(await getGlobalChannelRef());
  if (global) routes.set(global, null);
  return routes;
}

/** Health-strip check: a bot token plus at least one routable channel. */
export async function isSlackConfigured(): Promise<boolean> {
  const token = await getBotToken();
  if (!token) return false;
  if (await getGlobalChannelRef()) return true;
  const projectChannel = await prisma.sandboxConfig.findFirst({
    where: { NOT: { slackChannelId: null } },
    select: { projectId: true },
  });
  return projectChannel !== null;
}

// auth.test result cache — the workspace/bot identity backs the settings
// page's "connected as" line and only changes if the token does.
let identityCache: {
  token: string;
  identity: { team: string; botUser: string } | null;
} | null = null;

/** Workspace + bot user the token belongs to — null if unconfigured/invalid. */
export async function getSlackIdentity(): Promise<{
  team: string;
  botUser: string;
} | null> {
  const token = await getBotToken();
  if (!token) return null;
  if (identityCache?.token === token) return identityCache.identity;
  const res = (await callApi(token, "auth.test", {})) as {
    team?: string;
    user?: string;
  } | null;
  const identity = res?.team ? { team: res.team, botUser: res.user ?? "bot" } : null;
  identityCache = { token, identity };
  return identity;
}

/** Slack mrkdwn escapes only these three — quotes stay as-is. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Agent replies are GitHub-flavored markdown; Slack speaks mrkdwn. Rendered
 * raw, `**bold**` shows literal asterisks and tables arrive as pipe soup.
 * Best-effort conversion: bold/strike/links/headings translate, table rows
 * become bullets (their cells joined with —), code fences pass through.
 * Call AFTER escapeSlack — the link syntax this inserts must survive.
 */
export function mdToMrkdwn(md: string): string {
  const lines = md
    .split("\n")
    .map((line) => {
      // |---|---| separator rows carry no content — drop them.
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return null;
      // | a | b | data rows → "• a — b"
      const row = line.match(/^\s*\|(.+)\|\s*$/);
      if (row) {
        const cells = row[1]
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        return cells.length ? `• ${cells.join(" — ")}` : null;
      }
      // # Heading → bold line
      const h = line.match(/^\s*#{1,6}\s+(.*)$/);
      if (h) return `*${h[1].trim()}*`;
      return line;
    })
    .filter((l): l is string => l !== null)
    .join("\n");
  return lines
    .replace(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/~~(.+?)~~/gs, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>");
}

/**
 * Cut long report bodies at a line/word boundary instead of mid-word,
 * close a code fence the cut left open, and say that a cut happened.
 */
export function truncateForSlack(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (lastBreak > max * 0.6) cut = cut.slice(0, lastBreak);
  cut = cut.trimEnd();
  if ((cut.match(/```/g)?.length ?? 0) % 2 === 1) cut += "\n```";
  return `${cut}\n_… truncated — the full report is in Nexus._`;
}

/** The full pipeline for an agent report headed to a Slack message. */
function slackBody(result: string, max: number): string {
  return truncateForSlack(mdToMrkdwn(escapeSlack(result)), max);
}

async function callApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
    } & Record<string, unknown>;
    if (!json.ok) {
      // e.g. "channel_not_found" for a mistyped id, "not_in_channel" when the
      // bot was never invited — surface it, or a lost notification is
      // undiagnosable. Never log the token.
      console.error(
        `[slack] ${method} failed${"channel" in body ? ` (channel ${body.channel})` : ""}: ${json.error ?? "unknown error"}`,
      );
      return null;
    }
    return json;
  } catch (err) {
    console.error(`[slack] ${method} request failed:`, err);
    return null;
  }
}

/** Read methods take query params, not JSON bodies. */
export async function callApiGet(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<unknown | null> {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API}/${method}?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & Record<
      string,
      unknown
    >;
    if (!json.ok) {
      console.error(`[slack] ${method} failed: ${json.error ?? "unknown error"}`);
      return null;
    }
    return json;
  } catch (err) {
    console.error(`[slack] ${method} request failed:`, err);
    return null;
  }
}

/** Send an mrkdwn-formatted message to one channel. No-op without a token. */
export async function sendSlackMessage(
  text: string,
  channelId: string,
): Promise<boolean> {
  const token = await getBotToken();
  if (!token || !channelId) return false;
  const result = await callApi(token, "chat.postMessage", {
    channel: channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  return result !== null;
}

/** Post into an existing thread — how the socket answers a reply. */
export async function sendSlackReply(
  text: string,
  channelId: string,
  threadTs: string,
): Promise<boolean> {
  const token = await getBotToken();
  if (!token || !channelId) return false;
  const result = await callApi(token, "chat.postMessage", {
    channel: channelId,
    text,
    thread_ts: threadTs,
    unfurl_links: false,
    unfurl_media: false,
  });
  return result !== null;
}

/**
 * Send local image files to a channel. Uses the external-upload flow
 * (files.upload was retired): one upload URL per file, then a single
 * completeUploadExternal that drops them all into the channel.
 */
export async function sendSlackImages(
  channelId: string,
  files: string[],
  caption?: string,
): Promise<boolean> {
  const token = await getBotToken();
  if (!token || !channelId || files.length === 0) return false;
  const batch = files.slice(0, 10);
  try {
    const uploaded: Array<{ id: string; title: string }> = [];
    for (const file of batch) {
      const data = fs.readFileSync(file);
      const name = path.basename(file);
      // Step 1 wants form encoding, not JSON — it predates the JSON APIs.
      const urlRes = await fetch(`${API}/files.getUploadURLExternal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${token}`,
        },
        body: new URLSearchParams({
          filename: name,
          length: String(data.length),
        }),
      });
      const urlJson = (await urlRes.json()) as {
        ok: boolean;
        upload_url?: string;
        file_id?: string;
        error?: string;
      };
      if (!urlJson.ok || !urlJson.upload_url || !urlJson.file_id) {
        console.error(
          `[slack] getUploadURLExternal failed: ${urlJson.error ?? "unknown error"}`,
        );
        continue;
      }
      const put = await fetch(urlJson.upload_url, {
        method: "POST",
        body: new Blob([data]),
      });
      if (!put.ok) {
        console.error(`[slack] upload of ${name} failed: HTTP ${put.status}`);
        continue;
      }
      uploaded.push({ id: urlJson.file_id, title: name });
    }
    if (uploaded.length === 0) return false;

    const done = await callApi(token, "files.completeUploadExternal", {
      files: uploaded,
      channel_id: channelId,
      ...(caption ? { initial_comment: caption } : {}),
    });
    return done !== null;
  } catch (err) {
    console.error("[slack] image send failed:", err);
    return false;
  }
}

/** A task's collected screenshots (if any) as absolute local paths. */
async function taskScreenshotFiles(taskId: string): Promise<string[]> {
  // Lazy import: task-manager reaches this module through the notify hub.
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
// Notifications — same events Telegram gets, rendered as mrkdwn.
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "";
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/** Pure so it's testable: the mrkdwn body for a finished pipeline task. */
export function renderTaskFinishedSlack(task: {
  id: string;
  status: string;
  prompt: string;
  error: string | null;
  result: string | null;
  durationMs: number | null;
  costUsd: number | null;
  prUrl: string | null;
  previewUrl: string | null;
  sandboxName: string;
  featureTitle: string | null;
}): string {
  const ok = task.status === "completed";
  const title = task.featureTitle ?? task.prompt.slice(0, 80);
  const lines = [
    `${ok ? "✅" : "❌"} *${escapeSlack(title)}*`,
    `Sandbox: \`${escapeSlack(task.sandboxName)}\``,
  ];
  if (!ok && task.error) {
    lines.push(`Error: ${escapeSlack(task.error.slice(0, 300))}`);
  }
  if (ok && task.result) {
    lines.push("", slackBody(task.result, 1500));
  }
  const meta: string[] = [];
  const dur = formatDuration(task.durationMs);
  if (dur) meta.push(dur);
  if (task.costUsd) meta.push(`$${task.costUsd.toFixed(2)}`);
  if (meta.length) lines.push("", meta.join(" · "));
  if (task.prUrl) lines.push(`PR: ${task.prUrl}`);
  if (task.previewUrl) lines.push(`Preview: ${task.previewUrl}`);
  lines.push("", `↩️ Reply in this thread to continue the task. #task_${task.id}`);
  return lines.join("\n");
}

/** Pure so it's testable: the mrkdwn body for a dev-console prompt. */
export function renderDevTaskSlack(task: {
  id: string;
  status: string;
  phase: string | null;
  prompt: string;
  error: string | null;
  result: string | null;
  durationMs: number | null;
  costUsd: number | null;
  prUrl: string | null;
  sandboxName: string;
}): string {
  const needsInput = task.phase === "needs_input";
  const ok = task.status === "completed";
  const icon = !ok ? "⚠️" : needsInput ? "🙋" : "💬";
  const lines = [
    `${icon} *${escapeSlack(task.prompt.slice(0, 80))}*`,
    `Dev sandbox: \`${escapeSlack(task.sandboxName)}\`${needsInput ? " · needs your input" : ""}`,
  ];
  if (!ok && task.error) {
    lines.push(`Error: ${escapeSlack(task.error.slice(0, 300))}`);
  }
  if (ok && task.result) {
    lines.push("", slackBody(task.result, 1500));
  }
  const meta: string[] = [];
  const dur = formatDuration(task.durationMs);
  if (dur) meta.push(dur);
  if (task.costUsd) meta.push(`$${task.costUsd.toFixed(2)}`);
  if (meta.length) lines.push("", meta.join(" · "));
  if (task.prUrl) lines.push(`PR: ${task.prUrl}`);
  lines.push("", `↩️ Reply in this thread to send the next prompt. #task_${task.id}`);
  return lines.join("\n");
}

/** Notify the owning project's channel that a task finished. */
export async function notifySlackTaskFinished(taskId: string): Promise<void> {
  const task = await prisma.sandboxTask.findUnique({
    where: { id: taskId },
    include: { sandbox: true, feature: true },
  });
  if (!task) return;
  if (task.sandbox.muteSlack) return;
  const channelId = await resolveProjectChannelId(task.sandbox.projectId);
  if (!channelId) return;

  await sendSlackMessage(
    renderTaskFinishedSlack({
      ...task,
      sandboxName: task.sandbox.name,
      featureTitle: task.feature?.title ?? null,
    }),
    channelId,
  );

  const title = task.feature?.title ?? task.prompt.slice(0, 80);
  const shots = await taskScreenshotFiles(task.id).catch(() => []);
  if (shots.length > 0) {
    await sendSlackImages(channelId, shots, `📸 ${title.slice(0, 200)}`);
  }
}

/** Dev-console prompt finished / needs input / failed. */
export async function notifySlackDevTask(taskId: string): Promise<void> {
  const task = await prisma.sandboxTask.findUnique({
    where: { id: taskId },
    include: { sandbox: true },
  });
  if (!task || task.kind !== "dev") return;
  if (task.sandbox.muteSlack) return;
  const channelId = await resolveProjectChannelId(task.sandbox.projectId);
  if (!channelId) return;

  await sendSlackMessage(
    renderDevTaskSlack({ ...task, sandboxName: task.sandbox.name }),
    channelId,
  );

  const shots = await taskScreenshotFiles(task.id).catch(() => []);
  if (shots.length > 0) {
    await sendSlackImages(channelId, shots, `📸 ${task.prompt.slice(0, 200)}`);
  }
}

/** Sandbox provisioned or failed. */
export async function notifySlackSandboxStatus(
  sandboxId: string,
): Promise<void> {
  const sandbox = await prisma.sandbox.findUnique({ where: { id: sandboxId } });
  if (!sandbox) return;
  if (sandbox.muteSlack) return;
  const channelId = await resolveProjectChannelId(sandbox.projectId);
  if (!channelId) return;

  if (sandbox.status === "running") {
    await sendSlackMessage(
      [
        `🚀 Sandbox \`${escapeSlack(sandbox.name)}\` is ready`,
        `${sandbox.size} @ ${sandbox.region}${sandbox.publicIp ? ` · ${sandbox.publicIp}` : ""}`,
        "",
        `↩️ Reply in this thread with a prompt to run a task on it. #sandbox_${sandbox.id}`,
      ].join("\n"),
      channelId,
    );
  } else if (sandbox.status === "error") {
    await sendSlackMessage(
      `❌ Sandbox \`${escapeSlack(sandbox.name)}\` failed to provision:\n${escapeSlack((sandbox.error ?? "unknown error").slice(0, 300))}`,
      channelId,
    );
  }
}
