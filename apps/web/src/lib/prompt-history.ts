// ↑ / ↓ in a chat's composer walk back through what you sent, like a shell.
// Pure, for tests.

/** What you sent, oldest first, without blanks or a message repeated right after itself. */
export function promptHistory(sent: string[]): string[] {
  const out: string[] = [];
  for (const raw of sent) {
    const text = raw.trim();
    if (text && out.at(-1) !== text) out.push(text);
  }
  return out;
}

/**
 * Where ↑ (-1) or ↓ (+1) goes. `index` null is the draft being written;
 * ↓ past the newest message brings the draft back. Null when nothing moves.
 */
export function stepHistory(
  history: string[],
  index: number | null,
  dir: -1 | 1,
): { index: number | null } | null {
  if (history.length === 0) return null;
  if (index === null) return dir === -1 ? { index: history.length - 1 } : null;
  const next = index + dir;
  if (next < 0) return null;
  if (next >= history.length) return { index: null };
  return { index: next };
}

/** ↑ only from the first line, ↓ only from the last, so moving inside a long message still works. */
export function caretAllowsHistory(value: string, caret: number, dir: -1 | 1): boolean {
  return dir === -1 ? !value.slice(0, caret).includes("\n") : !value.slice(caret).includes("\n");
}
