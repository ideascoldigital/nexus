// Workspace isolation helpers.
//
// The active workspace travels in a plain cookie: server components and API
// routes read it with next/headers, the sidebar switcher sets it and reloads.
// Everything created before workspaces lives in the seeded default one, and
// setting reads fall back to it so global tokens keep working until a
// workspace defines its own.

import { cookies } from "next/headers";
import { prisma, type Settings } from "@nexux/db";

export const DEFAULT_WORKSPACE_ID = "ws-default";
export const WORKSPACE_COOKIE = "nexux-workspace";

/**
 * Test-only override for the active workspace. `cookies()` throws outside a
 * Next request scope, which is where unit tests call route handlers from, so
 * the cookie read is skipped when this is set. Guarded by NEXUX_TEST_WORKSPACE
 * rather than a mutable module variable so production has no way to reach it.
 */
function testWorkspaceOverride(): string | null {
  return process.env.NEXUX_TEST_WORKSPACE || null;
}

/** Active workspace for this request — unknown/stale cookie falls back. */
export async function getActiveWorkspaceId(): Promise<string> {
  const id = testWorkspaceOverride() ?? (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (!id || id === DEFAULT_WORKSPACE_ID) return DEFAULT_WORKSPACE_ID;
  const ws = await prisma.workspace.findUnique({
    where: { id },
    select: { id: true },
  });
  return ws ? id : DEFAULT_WORKSPACE_ID;
}

/** The workspace a project belongs to (default for unknown projects). */
export async function workspaceIdOfProject(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  return project?.workspaceId ?? DEFAULT_WORKSPACE_ID;
}

/**
 * Settings stay in the single key/value table; non-default workspaces prefix
 * their keys ("ws:<id>:<key>"). The default workspace keeps bare keys, so
 * everything configured before workspaces behaves exactly as before.
 */
export function scopedSettingKey(workspaceId: string, key: string): string {
  return workspaceId === DEFAULT_WORKSPACE_ID
    ? key
    : `ws:${workspaceId}:${key}`;
}

/**
 * Workspace-scoped setting with default-workspace fallback: a workspace
 * without its own token inherits the global one instead of breaking.
 */
export async function getWorkspaceSetting(
  workspaceId: string,
  key: string,
): Promise<Settings | null> {
  if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    const scoped = await prisma.settings.findFirst({
      where: { key: scopedSettingKey(workspaceId, key), isActive: true },
    });
    if (scoped) return scoped;
  }
  return prisma.settings.findFirst({ where: { key, isActive: true } });
}

/** Boot-time guard: the default workspace must always exist. */
export async function ensureDefaultWorkspace(): Promise<void> {
  await prisma.workspace
    .upsert({
      where: { id: DEFAULT_WORKSPACE_ID },
      update: {},
      create: { id: DEFAULT_WORKSPACE_ID, name: "Personal" },
    })
    .catch(() => undefined);
}
