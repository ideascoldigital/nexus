// Server half of attachments (bot-attachments.ts): store an upload, and copy
// a message's attachments into the bot's computer when it runs.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyToBot } from "@nexux/sandbox";

import { attachmentPath, MAX_ATTACHMENTS, safeUploadName, splitAttachments, withDeliveredAttachments } from "@/lib/bot-attachments";
import { botFileUrl, botFilesDir } from "@/lib/bot-files";

/** Store an upload; returns its Nexus URL. */
export function saveUpload(botId: string, rawName: string, bytes: Buffer): { url: string; name: string } {
  const name = safeUploadName(rawName);
  const id = `up-${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  const dir = botFilesDir(botId, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
  return { url: botFileUrl(botId, id, name), name };
}

/**
 * Copy the files this message attaches into the bot's computer. A file that
 * cannot be copied keeps its Nexus link, which the manager makes absolute —
 * the bot can still download it.
 */
export async function deliverAttachments(opts: {
  botId: string;
  prompt: string;
  container: string;
  dockerHost?: string | null;
  workdir: string;
}): Promise<string> {
  const { attachments } = splitAttachments(opts.prompt);
  const own = attachments.filter((a) => a.url.startsWith(`/api/bots/${opts.botId}/files/`)).slice(0, MAX_ATTACHMENTS * 2);
  if (own.length === 0) return opts.prompt;
  const delivered = new Map<string, string>();
  const taken = new Set<string>();
  for (const a of own) {
    if (delivered.has(a.url)) continue;
    const dir = botFilesDir(opts.botId, a.uploadId);
    const src = path.resolve(dir, a.name);
    if (!src.startsWith(dir + path.sep) || !fs.existsSync(src)) continue;
    const dest = attachmentPath(opts.workdir, a, taken);
    const ok = await copyToBot(opts.container, src, dest, { host: opts.dockerHost ?? null }).catch(() => false);
    if (ok) delivered.set(a.url, dest);
  }
  return withDeliveredAttachments(opts.prompt, delivered);
}
