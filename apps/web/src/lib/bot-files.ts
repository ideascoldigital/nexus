// Files a bot hands the user (spec 31). The bot saves them in its outbox and
// references them in its reply (`![caption](outbox://slide-1.png)`); after the
// run, the manager copies each one out of the container into the data dir and
// rewrites the reference to a Nexus URL, so the chat shows images inline and
// other files as downloads — the container (and its files) may be gone later.

import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@nexux/config";
import { BOT_OUTBOX, botFileSize, copyFromBot } from "@nexux/sandbox";

export const MAX_FILES_PER_REPLY = 20;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** One reference to a file in the outbox: the URL as written, and the file name inside the outbox. */
export type OutboxRef = { url: string; name: string };

const LINK = /\]\(\s*<?([^)\s>]+)>?\s*(?:"[^"]*")?\s*\)/g;

/** The outbox file a markdown link target points at, or null. Only plain names inside the outbox count. */
export function outboxName(url: string): string | null {
  let rel: string | null = null;
  if (url.startsWith("outbox://")) rel = url.slice("outbox://".length);
  else if (url.startsWith("file://" + BOT_OUTBOX + "/")) rel = url.slice(("file://" + BOT_OUTBOX + "/").length);
  else if (url.startsWith(BOT_OUTBOX + "/")) rel = url.slice(BOT_OUTBOX.length + 1);
  if (rel === null) return null;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  // One level, no traversal: "slide-1.png", "Informe final.pdf".
  if (!/^[\w.\- ()]+$/.test(rel) || rel.startsWith(".") || rel.length > 120) return null;
  return rel;
}

export function findOutboxRefs(text: string): OutboxRef[] {
  const seen = new Map<string, OutboxRef>();
  for (const m of text.matchAll(LINK)) {
    const name = outboxName(m[1]!);
    if (name && !seen.has(m[1]!)) seen.set(m[1]!, { url: m[1]!, name });
  }
  return [...seen.values()].slice(0, MAX_FILES_PER_REPLY);
}

export function botFilesDir(botId: string, runId?: string): string {
  const base = path.join(getConfig().dataDir, "bot-files", botId);
  return runId ? path.join(base, runId) : base;
}

export function botFileUrl(botId: string, runId: string, name: string): string {
  return `/api/bots/${botId}/files/${runId}/${encodeURIComponent(name)}`;
}

/** Swap each reference for its Nexus URL (or a note when it could not be fetched). */
export function rewriteOutboxRefs(text: string, done: Map<string, string | null>): string {
  return text.replace(LINK, (whole, url: string) => {
    if (!done.has(url)) return whole;
    const to = done.get(url);
    return to ? whole.replace(url, to) : whole.replace(url, "#missing-file");
  });
}

/**
 * Copy the files a reply references out of the bot's computer and point the
 * reply at them. Missing, oversized or non-regular files are left as a
 * "#missing-file" link, so the chat says so instead of showing a broken image.
 */
export async function collectBotFiles(opts: {
  botId: string;
  runId: string;
  container: string;
  /** The daemon the container is on; null = this machine (D-85). */
  dockerHost?: string | null;
  text: string;
}): Promise<string> {
  const refs = findOutboxRefs(opts.text);
  if (refs.length === 0) return opts.text;
  const dir = botFilesDir(opts.botId, opts.runId);
  fs.mkdirSync(dir, { recursive: true });
  const done = new Map<string, string | null>();
  for (const ref of refs) {
    const remote = `${BOT_OUTBOX}/${ref.name}`;
    const target = { host: opts.dockerHost ?? null };
    const size = await botFileSize(opts.container, remote, target);
    if (size === null || size > MAX_FILE_BYTES) {
      done.set(ref.url, null);
      continue;
    }
    // `docker cp` reads from the daemon and writes here, so a file made on
    // another machine still lands in Nexus's own folder.
    const ok = await copyFromBot(opts.container, remote, path.join(dir, ref.name), target);
    done.set(ref.url, ok ? botFileUrl(opts.botId, opts.runId, ref.name) : null);
  }
  return rewriteOutboxRefs(opts.text, done);
}

/** A bot is deleted: its files go with it. */
export function removeBotFiles(botId: string): void {
  fs.rmSync(botFilesDir(botId), { recursive: true, force: true });
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".html": "text/plain; charset=utf-8", // shown as text, never run in Nexus's origin
  ".zip": "application/zip",
};

export function contentTypeFor(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
