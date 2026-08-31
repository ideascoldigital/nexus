import { safeSlug } from "./slug";

// VS Code opens a *single* folder per window unless it is handed a
// `.code-workspace` file. A sandbox holds N repos side by side under
// /opt/nexus, so pointing the deep link at /opt/nexus would show them nested
// one level down. This module renders a multi-root workspace file instead:
// every repo becomes a first-level folder in the explorer.

/** Where the generated workspace file lives on the sandbox. */
export const SANDBOX_WORKSPACE_PATH = "/opt/nexus/nexus.code-workspace";

/** Root the repo checkouts (and the workspace file) sit under. */
export const SANDBOX_ROOT = "/opt/nexus";

export interface WorkspaceFolder {
  /** Repo display name — becomes the explorer label. */
  name: string;
  /** Directory under /opt/nexus; defaults to safeSlug(name). */
  dir?: string;
}

/** The fields that decide which checkout a task runs in. */
export interface MainRepoCandidate {
  name: string;
  isMain: boolean;
  createdAt: Date;
  repoUrl: string | null;
  localPath: string | null;
}

/**
 * The repo every agent task runs in — the one whose absence makes a sandbox
 * useless, since it is the `cd` target of every dispatch.
 *
 * Shared rather than re-sorted per call site: the bootstrap has to mark the
 * same repo fatal that `resolveWorkDir` will later cd into, and two copies of
 * "isMain, then oldest" drift into a sandbox that bootstraps happily and then
 * fails every task against a directory nobody cloned.
 */
export function pickMainRepo<T extends MainRepoCandidate>(
  repos: readonly T[],
): T | null {
  const usable = repos.filter((r) => r.repoUrl || r.localPath);
  if (usable.length === 0) return null;
  return [...usable].sort(
    (a, b) =>
      Number(b.isMain) - Number(a.isMain) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  )[0];
}

/** Checkout directory for a repo, by display name. */
export function repoDir(name: string): string {
  return `${SANDBOX_ROOT}/${safeSlug(name)}`;
}

/**
 * Render the `.code-workspace` JSON for a sandbox. Paths are relative to the
 * file's own directory (/opt/nexus), so the same file works over Remote-SSH
 * and Dev Containers alike. Duplicate slugs are dropped — two folders with the
 * same path would render as one anyway.
 */
export function renderCodeWorkspace(repos: WorkspaceFolder[]): string {
  const seen = new Set<string>();
  const folders: { name: string; path: string }[] = [];
  for (const repo of repos) {
    const dir = repo.dir ?? safeSlug(repo.name);
    if (seen.has(dir)) continue;
    seen.add(dir);
    folders.push({ name: repo.name, path: `./${dir}` });
  }

  return `${JSON.stringify(
    {
      folders,
      settings: {
        // The repos live outside the user's home; without this, the explorer
        // shows every dotfile the bootstrap wrote at the root.
        "files.exclude": { "**/.bootstrap-complete": true },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Which folder the VS Code deep link should open.
 *
 * The multi-root workspace is the default: opening SANDBOX_ROOT instead would
 * bury every repo one level down in the explorer. An explicit path only wins
 * when the user actually picked one — a path derived from "the main repo"
 * silently hides the other repos on a multi-repo project.
 */
export function resolveVsCodeFolder(opts: {
  /** A folder the user explicitly asked for, if any. */
  explicitPath?: string | null;
  /** Whether the workspace file exists (or was just written) on the sandbox. */
  workspaceReady: boolean;
  workspacePath?: string;
}): string {
  if (opts.explicitPath) return opts.explicitPath;
  return opts.workspaceReady
    ? (opts.workspacePath ?? SANDBOX_WORKSPACE_PATH)
    : SANDBOX_ROOT;
}

/**
 * Shell snippet that writes the workspace file on the sandbox. Uses a quoted
 * heredoc so nothing in the JSON is expanded by the remote shell.
 */
export function writeCodeWorkspaceCommand(
  repos: WorkspaceFolder[],
  workspacePath: string = SANDBOX_WORKSPACE_PATH,
): string {
  return [
    `mkdir -p ${SANDBOX_ROOT}`,
    `cat > ${workspacePath} <<'NEXUX_WORKSPACE_EOF'`,
    renderCodeWorkspace(repos).trimEnd(),
    "NEXUX_WORKSPACE_EOF",
  ].join("\n");
}
