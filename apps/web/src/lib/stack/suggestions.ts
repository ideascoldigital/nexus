// Parsing/sanitizing of assistant stack suggestions. Pure + client-safe:
// used by the server agent service and by the chat panel (re-parses persisted
// messages to re-render Apply buttons).

import type { StackSuggestion } from "./types";

const VALID_RUN_MODES = new Set(["docker", "local"]);

function sanitizeSuggestion(
  raw: Record<string, unknown>
): StackSuggestion | null {
  if (typeof raw?.reason !== "string") return null;
  const patchRaw = (raw.patch ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const key of [
    "image",
    "dockerfile",
    "buildContext",
    "command",
    "localCommand",
    "workdir",
  ]) {
    if (typeof patchRaw[key] === "string") patch[key] = patchRaw[key];
  }
  if (
    typeof patchRaw.runMode === "string" &&
    VALID_RUN_MODES.has(patchRaw.runMode)
  ) {
    patch.runMode = patchRaw.runMode;
  }
  if (Array.isArray(patchRaw.ports)) {
    patch.ports = (patchRaw.ports as Array<Record<string, unknown>>)
      .filter((p) => typeof p?.host === "number" && typeof p?.container === "number")
      .map((p) => ({ host: p.host, container: p.container }));
  }
  if (Array.isArray(patchRaw.env)) {
    patch.env = (patchRaw.env as Array<Record<string, unknown>>)
      .filter((e) => typeof e?.key === "string")
      .map((e) => ({
        key: e.key,
        value: typeof e.value === "string" ? e.value : "",
      }));
  }
  if (Array.isArray(patchRaw.volumes)) {
    patch.volumes = (patchRaw.volumes as Array<Record<string, unknown>>)
      .filter((v) => typeof v?.host === "string" && typeof v?.container === "string")
      .map((v) => ({ host: v.host, container: v.container }));
  }

  const createServiceRaw = raw.createService as
    | Record<string, unknown>
    | undefined;
  const suggestion: StackSuggestion = {
    reason: raw.reason,
    ...(typeof raw.nodeId === "string" ? { nodeId: raw.nodeId } : {}),
    ...(typeof raw.repositoryId === "string"
      ? { repositoryId: raw.repositoryId }
      : {}),
    ...(createServiceRaw &&
    (typeof createServiceRaw.catalogKey === "string" ||
      typeof createServiceRaw.image === "string")
      ? {
          createService: {
            ...(typeof createServiceRaw.catalogKey === "string"
              ? { catalogKey: createServiceRaw.catalogKey }
              : {}),
            ...(typeof createServiceRaw.image === "string"
              ? { image: createServiceRaw.image }
              : {}),
            ...(typeof createServiceRaw.name === "string"
              ? { name: createServiceRaw.name }
              : {}),
          },
        }
      : {}),
    ...(Object.keys(patch).length > 0
      ? { patch: patch as StackSuggestion["patch"] }
      : {}),
  };

  if (
    !suggestion.nodeId &&
    !suggestion.repositoryId &&
    !suggestion.createService
  ) {
    return null;
  }
  return suggestion;
}

const SUGGESTIONS_BLOCK_RE = /```json\s*([\s\S]*?)\s*```\s*$/;

export function parseStackSuggestions(response: string): {
  message: string;
  suggestions: StackSuggestion[];
} {
  const match = response.match(SUGGESTIONS_BLOCK_RE);
  if (!match) return { message: response, suggestions: [] };
  try {
    const parsed = JSON.parse(match[1]) as { suggestions?: unknown };
    if (!Array.isArray(parsed.suggestions)) {
      return { message: response, suggestions: [] };
    }
    const suggestions = (parsed.suggestions as Array<Record<string, unknown>>)
      .map(sanitizeSuggestion)
      .filter((s): s is StackSuggestion => s !== null);
    return {
      message: response.replace(SUGGESTIONS_BLOCK_RE, "").trimEnd(),
      suggestions,
    };
  } catch {
    return { message: response, suggestions: [] };
  }
}
