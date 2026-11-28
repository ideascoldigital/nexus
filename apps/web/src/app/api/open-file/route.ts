import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { prisma } from "@nexux/db";
import { expandHome } from "@nexux/storage";
import { NextRequest, NextResponse } from "next/server";

import { localRequestRejection } from "@/lib/local-request";
import { availableOpeners, openFileCommand, OPENERS, type OpenerId } from "@/lib/open-with";

export const dynamic = "force-dynamic";

/**
 * A file link in a chat reply (`/Users/…/a.ts:42`): open it in the user's
 * editor. Only a file inside one of the projects' folders — a reply is text a
 * model wrote, and it must not be able to launch whatever it names.
 */
export async function POST(req: NextRequest) {
  const rejected = localRequestRejection(req);
  if (rejected) return NextResponse.json({ error: rejected }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { path?: unknown; line?: unknown; column?: unknown; app?: unknown };
  if (typeof body.path !== "string" || !body.path.trim() || body.path.includes("\0")) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  const real = await fs.promises.realpath(expandHome(body.path.trim())).catch(() => null);
  if (!real) return NextResponse.json({ error: "That file is not on this machine" }, { status: 404 });

  const [projects, repos] = await Promise.all([
    prisma.project.findMany({ where: { workspacePath: { not: null } }, select: { workspacePath: true } }),
    prisma.repository.findMany({ where: { localPath: { not: null } }, select: { localPath: true } }),
  ]);
  const roots = [...projects.map((p) => p.workspacePath!), ...repos.map((r) => r.localPath!)].map((r) =>
    path.resolve(expandHome(r)),
  );
  const realRoots = await Promise.all(roots.map((r) => fs.promises.realpath(r).catch(() => null)));
  const inside = realRoots.some((r) => r && (real === r || real.startsWith(r + path.sep)));
  if (!inside) return NextResponse.json({ error: "Only files inside a project's folders open from the chat" }, { status: 403 });

  const installed = availableOpeners();
  const asked = OPENERS.includes(body.app as OpenerId) ? (body.app as OpenerId) : null;
  const app: OpenerId =
    asked && installed.includes(asked) ? asked : (["vscode", "cursor", "zed"] as const).find((a) => installed.includes(a)) ?? "finder";
  const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);
  const isDir = (await fs.promises.stat(real)).isDirectory();
  const [bin, ...args] = openFileCommand(isDir && app === "finder" ? "finder" : app, real, isDir ? {} : { line: num(body.line), column: num(body.column) });
  spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  return NextResponse.json({ opened: real, app });
}
