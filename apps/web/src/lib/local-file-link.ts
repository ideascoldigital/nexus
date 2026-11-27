// A link in a reply that points at a file on this Mac — `/Users/me/p/a.ts`,
// `~/p/a.ts:42`, `file:///…` — opens it in the user's editor instead of being
// sent to the browser as a page of this app. Pure, for tests.

export type LocalFileLink = { path: string; line?: number; column?: number };

const LOCAL_ROOT = /^(\/Users\/|\/home\/|\/Volumes\/|\/private\/|\/tmp\/|\/opt\/|~\/)/;

export function parseLocalFileLink(href: string | null | undefined): LocalFileLink | null {
  if (!href) return null;
  let raw = href.trim();
  if (raw.startsWith("file://")) raw = raw.slice("file://".length);
  try {
    raw = decodeURI(raw);
  } catch {
    // keep as written
  }
  raw = raw.replace(/#L(\d+)(?:C(\d+))?$/, ":$1:$2").replace(/:$/, "");
  if (!LOCAL_ROOT.test(raw) || raw.includes("\0")) return null;
  const m = raw.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  if (!m || !m[1]) return null;
  return {
    path: m[1],
    ...(m[2] ? { line: Number(m[2]) } : {}),
    ...(m[3] ? { column: Number(m[3]) } : {}),
  };
}
