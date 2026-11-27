// Files attached to a project-chat message (spec 39). The chat has no file
// tools — AGENTS.md allows it Nexus's tools and nothing else — so attachments
// travel inside the message itself: images and PDFs as content blocks (Claude
// sees them like a pasted screenshot), small text files inlined, and anything
// else named so the assistant can say it cannot open it.

import fs from "node:fs";
import path from "node:path";

import { splitAttachments } from "@/lib/bot-attachments";
import { botFilesDir } from "@/lib/bot-files";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const TEXT = /\.(txt|md|markdown|json|ya?ml|toml|csv|tsv|env\.example|ini|xml|html?|css|js|jsx|ts|tsx|py|go|rb|rs|java|kt|sh|sql|log)$/i;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_PDF = 20 * 1024 * 1024;
const MAX_TEXT = 100 * 1024;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

/**
 * The message as Claude gets it. `blocks` is null when nothing needs more
 * than text (then it goes as a plain `-p` prompt).
 */
export function nexusMessage(botId: string, prompt: string): { text: string; blocks: ContentBlock[] | null } {
  const { text, attachments } = splitAttachments(prompt);
  const own = attachments.filter((a) => a.url.startsWith(`/api/bots/${botId}/files/`));
  if (own.length === 0) return { text: prompt, blocks: null };

  const blocks: ContentBlock[] = [];
  const notes: string[] = [];
  for (const a of own) {
    const dir = botFilesDir(botId, a.uploadId);
    const file = path.resolve(dir, a.name);
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
      notes.push(`(attached "${a.name}" is no longer available)`);
      continue;
    }
    const size = fs.statSync(file).size;
    const ext = path.extname(a.name).toLowerCase();
    if (IMAGE_TYPES[ext] && size <= MAX_IMAGE) {
      blocks.push({ type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext]!, data: fs.readFileSync(file).toString("base64") } });
      notes.push(`(image attached: ${a.name})`);
    } else if (ext === ".pdf" && size <= MAX_PDF) {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(file).toString("base64") } });
      notes.push(`(PDF attached: ${a.name})`);
    } else if (TEXT.test(a.name) && size <= MAX_TEXT) {
      notes.push(`Attached file "${a.name}":\n\`\`\`\n${fs.readFileSync(file, "utf8")}\n\`\`\``);
    } else {
      notes.push(`(attached "${a.name}" — a file you cannot open here; say so if it matters)`);
    }
  }
  const full = [text.trim(), ...notes].filter(Boolean).join("\n\n");
  return blocks.length ? { text: full, blocks: [{ type: "text", text: full }, ...blocks] } : { text: full, blocks: null };
}
