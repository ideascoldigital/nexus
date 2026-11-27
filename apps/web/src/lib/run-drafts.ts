// The reply a run is writing right now (spec 39: the chat streams it in).
// Process memory only — a draft is gone the moment the run finishes and its
// result is saved, so nothing here needs to outlive the server. On globalThis
// so every route module of the dev server shares the one map.

const g = globalThis as { __nexuxRunDrafts?: Map<string, string> };
const drafts = (g.__nexuxRunDrafts ??= new Map<string, string>());

export function setRunDraft(runId: string, text: string) {
  if (text) drafts.set(runId, text);
  else drafts.delete(runId);
}

export function clearRunDraft(runId: string) {
  drafts.delete(runId);
}

export function runDraft(runId: string): string | null {
  return drafts.get(runId) ?? null;
}
