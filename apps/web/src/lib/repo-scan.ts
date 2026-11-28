// Finding the git repositories under a folder on this machine (spec 39): the
// wizard's "scan a directory" and the Nexus chat's scan tool.

import path from "path";
import { LocalFsStorage, expandHome } from "@nexux/storage";

export interface DiscoveredRepo {
  name: string;
  localPath: string;
  hasGit: boolean;
  /** Nested inside another repo found here (its name): a wrapper repo holding its own repos. */
  insideRepo?: string;
  /** Holds other repos: likely a wrapper — the ones inside are usually what is meant. */
  containsRepos?: number;
}

const storage = new LocalFsStorage("/");

async function scanForRepos(
  dirPath: string,
  maxDepth: number = 2,
  currentDepth: number = 0,
  insideRepo?: string,
): Promise<DiscoveredRepo[]> {
  const repos: DiscoveredRepo[] = [];

  if (currentDepth > maxDepth) return repos;

  try {
    // A folder with .git is a repo — but it may also hold repos of its own (a
    // wrapper repo around an api and a ui, or submodules). Stopping at the
    // first .git hid those: "simplifybot-app" came back alone when the user
    // meant the two inside it. So it is listed, and its folders still looked at.
    let parent = insideRepo;
    let self: DiscoveredRepo | null = null;
    if (await storage.exists(path.join(dirPath, ".git"))) {
      self = { name: path.basename(dirPath), localPath: dirPath, hasGit: true, ...(insideRepo ? { insideRepo } : {}) };
      repos.push(self);
      parent = self.name;
    }
    if (currentDepth === maxDepth) return repos;

    const entries = await storage.listDetailed(dirPath);
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      repos.push(...(await scanForRepos(path.join(dirPath, entry.name), maxDepth, currentDepth + 1, parent)));
    }
    if (self) {
      const inner = repos.filter((r) => r.insideRepo === self.name).length;
      if (inner) self.containsRepos = inner;
    }
  } catch {
    // Permission errors, etc.
  }

  return repos;
}

/** The repos under `directory` (up to two levels deep), or null when it is not a folder. */
export async function scanDirectory(
  directory: string,
): Promise<{ directory: string; repos: DiscoveredRepo[] } | null> {
  const resolved = expandHome(directory);
  const dirStat = await storage.stat(resolved).catch(() => null);
  if (!dirStat?.isDirectory) return null;
  const repos = await scanForRepos(resolved);
  return { directory: resolved, repos: repos.sort((a, b) => a.name.localeCompare(b.name)) };
}
