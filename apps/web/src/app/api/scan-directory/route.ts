import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { LocalFsStorage, expandHome } from "@nexux/storage";

interface DiscoveredRepo {
  name: string;
  localPath: string;
  hasGit: boolean;
}

const storage = new LocalFsStorage("/");

async function scanForRepos(
  dirPath: string,
  maxDepth: number = 2,
  currentDepth: number = 0,
): Promise<DiscoveredRepo[]> {
  const repos: DiscoveredRepo[] = [];

  if (currentDepth > maxDepth) return repos;

  try {
    // If the directory itself is a git repo, it IS the repo — return it. This
    // covers both nested repos found during recursion and the common case where
    // the user points the scan straight at a single-repo folder (currentDepth
    // === 0). Without the depth-0 case, scanning a lone repo yields 0 results.
    if (await storage.exists(path.join(dirPath, ".git"))) {
      repos.push({
        name: path.basename(dirPath),
        localPath: dirPath,
        hasGit: true,
      });
      return repos;
    }

    const entries = await storage.listDetailed(dirPath);

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = path.join(dirPath, entry.name);
      const childHasGit = await storage.exists(path.join(fullPath, ".git"));

      if (childHasGit) {
        repos.push({ name: entry.name, localPath: fullPath, hasGit: true });
      } else if (currentDepth < maxDepth) {
        const nested = await scanForRepos(fullPath, maxDepth, currentDepth + 1);
        repos.push(...nested);
      }
    }
  } catch {
    // Permission errors, etc.
  }

  return repos;
}

export async function POST(req: NextRequest) {
  const { directory } = (await req.json()) as { directory: string };

  if (!directory) {
    return NextResponse.json(
      { error: "Directory path is required" },
      { status: 400 },
    );
  }

  const resolved = expandHome(directory);

  let dirStat;
  try {
    dirStat = await storage.stat(resolved);
  } catch {
    dirStat = null;
  }

  if (!dirStat?.isDirectory) {
    return NextResponse.json(
      { error: "Path is not a valid directory" },
      { status: 400 },
    );
  }

  const repos = await scanForRepos(resolved);

  return NextResponse.json({
    directory: resolved,
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
  });
}
