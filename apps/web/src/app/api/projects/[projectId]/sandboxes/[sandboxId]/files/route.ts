import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@nexux/config";
import { execRemote, sandboxPrivateKeyPath, shq } from "@nexux/sandbox";

import { cleanSandboxPath, MAX_FILE_BYTES, parseListing } from "@/lib/sandbox-files";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/**
 * The Files surface of a project chat (spec 39): `?path=` lists a folder in
 * the sandbox, `?file=` reads the head of a file. Read-only.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;
  const wantsFile = req.nextUrl.searchParams.has("file");
  const target = cleanSandboxPath(req.nextUrl.searchParams.get(wantsFile ? "file" : "path"));
  if (!target) return NextResponse.json({ error: "Not a valid path" }, { status: 400 });

  const sandbox = await prisma.sandbox.findFirst({ where: { id: sandboxId, projectId } });
  if (!sandbox) return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  const isLocal = sandbox.provider === "local";
  if (sandbox.status !== "running" || (isLocal ? !sandbox.instanceId : !sandbox.publicIp)) {
    return NextResponse.json({ error: "The sandbox is not running" }, { status: 409 });
  }

  const command = wantsFile
    ? `head -c ${MAX_FILE_BYTES} -- ${shq(target)}`
    : `find ${shq(target)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n' 2>/dev/null | head -n 1000`;
  try {
    const res = await execRemote(
      command,
      isLocal
        ? { container: sandbox.instanceId!, dockerHost: sandbox.dockerHost, timeoutMs: 15_000 }
        : { host: sandbox.publicIp!, privateKeyPath: sandboxPrivateKeyPath(getConfig().dataDir), timeoutMs: 15_000 },
    );
    if (wantsFile) {
      const binary = res.stdout.includes("\0");
      return NextResponse.json({
        path: target,
        content: binary ? null : res.stdout,
        binary,
        truncated: Buffer.byteLength(res.stdout) >= MAX_FILE_BYTES,
      });
    }
    return NextResponse.json({ path: target, entries: parseListing(res.stdout) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not read the sandbox" }, { status: 502 });
  }
}
