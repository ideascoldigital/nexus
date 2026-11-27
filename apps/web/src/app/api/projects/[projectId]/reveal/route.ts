import fs from "fs";
import { spawn } from "child_process";
import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";

import { openerCommand } from "@/app/api/open-url/route";
import { localRequestRejection } from "@/lib/local-request";
import { availableOpeners, editorCommand, OPENERS, type OpenerId } from "@/lib/open-with";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/** Which apps can open the folder here: Finder always, and Cursor / VS Code / Zed when installed. */
export async function GET() {
  return NextResponse.json({ openers: availableOpeners() });
}

/**
 * "Open in …" on a project chat (spec 39): the project's own folder, as saved
 * on the project — never a path from the request — only if it exists, with
 * Finder or an installed editor (`{ app }`).
 */
export async function POST(req: NextRequest, { params }: Params) {
  // Opens a window on this machine: only from the app itself (a JSON POST a
  // web page elsewhere cannot send without a preflight).
  const rejected = localRequestRejection(req);
  if (rejected) return NextResponse.json({ error: rejected }, { status: 403 });
  const { projectId } = await params;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspacePath: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const dir = project.workspacePath;
  if (!dir || !fs.existsSync(dir)) {
    return NextResponse.json({ error: "This project has no folder on this machine" }, { status: 409 });
  }
  const body = (await req.json().catch(() => ({}))) as { app?: unknown };
  const app: OpenerId = OPENERS.includes(body.app as OpenerId) ? (body.app as OpenerId) : "finder";
  if (app !== "finder" && !availableOpeners().includes(app)) {
    return NextResponse.json({ error: "That app is not installed here" }, { status: 400 });
  }
  const [bin, ...args] = app === "finder" ? openerCommand(process.platform, dir) : editorCommand(app, dir);
  spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  return NextResponse.json({ opened: dir });
}
