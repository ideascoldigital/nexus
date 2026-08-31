// Minimal .env parser for the stack inspector's import. Deliberately small:
// it handles what a real .env file contains (comments, `export` prefixes,
// quoted values, escapes inside double quotes) and ignores the rest.

import type { EnvVar } from "./types";

// `s` so a joined multi-line quoted value still matches as one assignment.
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/s;

/** Strip a surrounding quote pair, unescaping only inside double quotes. */
function unquote(raw: string): string {
  // Only the outer edges are trimmed — whitespace *inside* a quoted value is
  // part of it (indented PEM bodies, formatted JSON).
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      const inner = value.slice(1, -1);
      return first === '"'
        ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"')
        : inner;
    }
  }
  // Unquoted: an unescaped ` #` starts a trailing comment.
  return value.replace(/\s+#.*$/, "").trim();
}

/**
 * Split into logical lines, joining a quoted value that runs past its own line
 * back together. Certificates and PEM keys are pasted that way, and treating
 * each physical line separately would truncate the value and then report the
 * remainder as garbage.
 *
 * Each entry keeps the 1-based number of the line it started on so diagnostics
 * still point at the right place.
 */
function logicalLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let buffer = lines[i];
    const rest = LINE_RE.exec(buffer)?.[2] ?? "";
    const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : null;
    if (quote && !closesQuote(rest.slice(1), quote)) {
      while (i + 1 < lines.length) {
        i++;
        buffer += "\n" + lines[i];
        if (closesQuote(lines[i], quote)) break;
      }
    }
    out.push({ line: start + 1, text: buffer });
  }
  return out;
}

/** Does `chunk` contain an unescaped closing `quote`? */
function closesQuote(chunk: string, quote: string): boolean {
  for (let i = 0; i < chunk.length; i++) {
    if (quote === '"' && chunk[i] === "\\") {
      i++;
      continue;
    }
    if (chunk[i] === quote) return true;
  }
  return false;
}

/**
 * Parse `.env` text into key/value pairs. Later definitions win, matching how
 * the shell and dotenv itself behave.
 */
export function parseDotenv(text: string): EnvVar[] {
  const out = new Map<string, string>();
  for (const entry of logicalLines(text)) {
    const line = entry.text.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    out.set(key, unquote(rawValue));
  }
  return [...out].map(([key, value]) => ({ key, value }));
}

/**
 * Parse `.env` text and also report the lines that were skipped.
 *
 * `parseDotenv` drops anything that isn't an assignment, which is right for the
 * stack inspector's paste box. The project env-var import previews the result
 * before writing, so it has to tell the user which lines will be ignored.
 */
export function parseDotenvWithDiagnostics(text: string): {
  entries: EnvVar[];
  invalidLines: Array<{ line: number; text: string }>;
} {
  const invalidLines: Array<{ line: number; text: string }> = [];
  // Walk the same logical lines the parser does, so the continuation of a
  // multi-line value is never reported as junk on its own.
  for (const entry of logicalLines(text)) {
    const line = entry.text.trim();
    if (!line || line.startsWith("#")) continue;
    if (!LINE_RE.test(line)) {
      invalidLines.push({ line: entry.line, text: line.split("\n")[0] });
    }
  }
  return { entries: parseDotenv(text), invalidLines };
}

/**
 * Merge parsed vars into existing ones: same key is overwritten in place,
 * new keys are appended, and untouched entries keep their order.
 */
export function mergeEnv(existing: EnvVar[], incoming: EnvVar[]): EnvVar[] {
  const merged = existing.map((e) => ({ ...e }));
  for (const item of incoming) {
    const hit = merged.find((e) => e.key === item.key);
    if (hit) hit.value = item.value;
    else merged.push({ ...item });
  }
  return merged;
}
