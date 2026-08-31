import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { LocalFsStorage, expandHome } from "@nexux/storage";
import { getConfig } from "@nexux/config";

export async function POST(req: NextRequest) {
  const { directory } = (await req.json()) as { directory?: string };

  // Browsing starts where checkouts are meant to go. On a host the shell's home
  // is not writable by the app's uid, so opening there invites picking a path
  // that cannot be cloned into.
  const resolved = directory
    ? expandHome(directory)
    : getConfig().workspaceRoot;

  const storage = new LocalFsStorage("/");

  try {
    // The default root need not exist yet on a fresh install — create it rather
    // than answering "Cannot read directory" for the one path we just suggested.
    if (!directory && !(await storage.exists(resolved))) {
      await fs.mkdir(resolved, { recursive: true });
    }

    const dirStat = await storage.stat(resolved);
    if (!dirStat.isDirectory) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    const entries = await storage.listDetailed(resolved);

    const dirs = entries
      .filter(
        (e) =>
          e.isDirectory &&
          !e.name.startsWith(".") &&
          e.name !== "node_modules" &&
          e.name !== "Library" &&
          e.name !== "Applications",
      )
      .map((e) => ({
        name: e.name,
        path: path.join(resolved, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const withGitInfo = await Promise.all(
      dirs.map(async (d) => ({
        ...d,
        isGitRepo: await storage.exists(path.join(d.path, ".git")),
      })),
    );

    return NextResponse.json({
      current: resolved,
      parent: path.dirname(resolved),
      dirs: withGitInfo,
    });
  } catch {
    return NextResponse.json(
      { error: "Cannot read directory" },
      { status: 400 },
    );
  }
}
