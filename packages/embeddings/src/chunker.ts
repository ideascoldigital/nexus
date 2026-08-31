export type SourceType =
  | "file"
  | "document_section"
  | "feature"
  | "message"
  | "skill";

export type Chunk = {
  text: string;
  chunkIndex: number;
  startLine?: number;
  endLine?: number;
  heading?: string;
};

const CODE_WINDOW_LINES = 60;
const CODE_OVERLAP_LINES = 10;
const MARKDOWN_MAX_CHARS = 4000; // worst-case code-dense ~ 2.5k tokens
const MAX_TEXT_CHARS = 6000; // hard cap, safely under 8192 token context for dense code

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

export function isMarkdownPath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return MARKDOWN_EXTS.has(filePath.slice(dot).toLowerCase());
}

export function chunkCode(content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length <= CODE_WINDOW_LINES && content.length <= MAX_TEXT_CHARS) {
    return [{ text: content, chunkIndex: 0, startLine: 1, endLine: lines.length }];
  }

  const stride = CODE_WINDOW_LINES - CODE_OVERLAP_LINES;
  const chunks: Chunk[] = [];
  let idx = 0;

  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + CODE_WINDOW_LINES, lines.length);
    const slice = lines.slice(start, end).join("\n");
    for (const piece of splitByChars(slice, MAX_TEXT_CHARS)) {
      chunks.push({
        text: piece,
        chunkIndex: idx++,
        startLine: start + 1,
        endLine: end,
      });
    }
    if (end === lines.length) break;
  }

  return chunks;
}

export function chunkMarkdown(content: string): Chunk[] {
  // split by top-level headings (# / ## / ###), keep heading with body
  const lines = content.split(/\r?\n/);
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } = { heading: "", body: [] };

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (current.body.length || current.heading) sections.push(current);
      current = { heading: line.replace(/^#+\s+/, "").trim(), body: [line] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length || current.heading) sections.push(current);

  const chunks: Chunk[] = [];
  let idx = 0;
  for (const sec of sections) {
    const text = sec.body.join("\n").trim();
    if (!text) continue;
    for (const piece of splitByChars(text, MARKDOWN_MAX_CHARS)) {
      chunks.push({ text: piece, chunkIndex: idx++, heading: sec.heading || undefined });
    }
  }

  return chunks.length ? chunks : [{ text: content.slice(0, MAX_TEXT_CHARS), chunkIndex: 0 }];
}

export function chunkPlain(content: string, maxChars = MAX_TEXT_CHARS): Chunk[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) {
    return [{ text: trimmed, chunkIndex: 0 }];
  }
  return splitByChars(trimmed, maxChars).map((text, i) => ({ text, chunkIndex: i }));
}

export function chunkForFile(filePath: string, content: string): Chunk[] {
  if (isMarkdownPath(filePath)) return chunkMarkdown(content);
  return chunkCode(content);
}

function splitByChars(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + maxChars));
    i += maxChars;
  }
  return out;
}
