// Which Ollama the embedder talks to, per workspace.
//
// Settings → AI Providers saves an "Ollama URL" (`ollama_url`), workspace-
// scoped like every other setting. `@nexux/embeddings` stays free of database
// reads, so the lookup lives here and the resolved address is passed down;
// the precedence itself (setting, then OLLAMA_URL, then localhost) is
// `resolveOllamaHost` in the package.
//
// Server-only: `@nexux/db` is not something a client component may pull in.

import {
  resolveOllamaHost,
  type ResolvedOllamaHost,
} from "@nexux/embeddings/embedder";

import {
  getActiveWorkspaceId,
  getWorkspaceSetting,
  workspaceIdOfProject,
} from "@/lib/workspace";

export const OLLAMA_URL_SETTING = "ollama_url";

/**
 * The resolution against an injected setting reader, so the precedence can be
 * tested without a database.
 */
export async function ollamaHostFrom(
  readSetting: (key: string) => Promise<string | null>,
): Promise<ResolvedOllamaHost> {
  return resolveOllamaHost(await readSetting(OLLAMA_URL_SETTING));
}

/**
 * The workspace's Ollama. A settings read that fails (database down, say)
 * falls back to the environment rather than taking search down with it.
 */
export async function ollamaHostForWorkspace(
  workspaceId: string,
): Promise<ResolvedOllamaHost> {
  return ollamaHostFrom(async (key) => {
    const row = await getWorkspaceSetting(workspaceId, key).catch(() => null);
    return row?.value ?? null;
  });
}

/** Same, resolved through the workspace the project belongs to. */
export async function ollamaHostForProject(
  projectId: string,
): Promise<ResolvedOllamaHost> {
  const workspaceId = await workspaceIdOfProject(projectId).catch(() => null);
  return workspaceId ? ollamaHostForWorkspace(workspaceId) : resolveOllamaHost();
}

/** Same, for the workspace this request is in (Settings, health checks). */
export async function activeOllamaHost(): Promise<ResolvedOllamaHost> {
  return ollamaHostForWorkspace(await getActiveWorkspaceId());
}
