// The prefix generated sandbox names carry (`nexux-my-repo-abc123`), as a
// workspace setting rather than a constant. Sandboxes show up in `docker ps`,
// ssh config and VS Code host lists next to everything else on the machine, so
// which word they start with is the user's call, not the product's.
//
// Server-only: `@nexux/sandbox` reaches for child_process at import time, and
// `@nexux/db` is not something a client component may pull in either.

import {
  DEFAULT_SANDBOX_PREFIX,
  normalizeSandboxPrefix,
} from "@nexux/sandbox";
import { prisma } from "@nexux/db";
import {
  getWorkspaceSetting,
  scopedSettingKey,
  workspaceIdOfProject,
} from "@/lib/workspace";

export const SANDBOX_PREFIX_SETTING = "sandbox_name_prefix";

/** The raw stored value, or null when the workspace has never set one. */
export async function storedSandboxPrefix(
  workspaceId: string,
): Promise<string | null> {
  const row = await getWorkspaceSetting(workspaceId, SANDBOX_PREFIX_SETTING);
  return row?.value?.trim() || null;
}

/**
 * The prefix to actually name new sandboxes with.
 *
 * A stored value is normalized again on the way out: it was written by a route
 * that validated it, but the row can also arrive from a config import or a hand
 * edit of the database, and a malformed prefix would produce container names
 * docker rejects. An unusable one falls back to the default rather than failing
 * a launch over a settings field.
 */
export async function sandboxPrefixForWorkspace(
  workspaceId: string,
): Promise<string> {
  const stored = await storedSandboxPrefix(workspaceId);
  if (!stored) return DEFAULT_SANDBOX_PREFIX;
  const parsed = normalizeSandboxPrefix(stored);
  return "prefix" in parsed ? parsed.prefix : DEFAULT_SANDBOX_PREFIX;
}

/** Same, resolved through the workspace the project belongs to. */
export async function sandboxPrefixForProject(
  projectId: string,
): Promise<string> {
  return sandboxPrefixForWorkspace(await workspaceIdOfProject(projectId));
}

/** Persist a normalized prefix for the workspace. */
export async function setSandboxPrefix(
  workspaceId: string,
  prefix: string,
): Promise<void> {
  const key = scopedSettingKey(workspaceId, SANDBOX_PREFIX_SETTING);
  await prisma.settings.upsert({
    where: { key },
    update: { value: prefix, isActive: true },
    create: { key, value: prefix, provider: "sandbox", isActive: true },
  });
}

/**
 * Forget the workspace's prefix, putting new sandboxes back on the default.
 *
 * Only the workspace's own row is dropped — `getWorkspaceSetting` falls back to
 * the default workspace's value, which belongs to that workspace to clear.
 */
export async function clearSandboxPrefix(workspaceId: string): Promise<void> {
  await prisma.settings.deleteMany({
    where: { key: scopedSettingKey(workspaceId, SANDBOX_PREFIX_SETTING) },
  });
}
