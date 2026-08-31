import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@nexux/config";
import { execRemote, sandboxPrivateKeyPath } from "@nexux/sandbox";
import { bootstrapLogCommand, parseBootstrapLog } from "@/lib/bootstrap-log";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// Tails /var/log/nexus-bootstrap.log on the instance — what cloud-init is
// actually doing (apt, node, docker, claude, gh, clone, install) — plus the
// WARNs and registration URL from the whole file, which a finished bootstrap
// has long since scrolled past. Both live in @/lib/bootstrap-log.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }
  const isLocal = sandbox.provider === "local";
  // A local container can be tailed while it's still provisioning; SSH needs
  // the cloud instance fully up.
  const reachable = isLocal
    ? Boolean(sandbox.instanceId)
    : sandbox.status === "running" && Boolean(sandbox.publicIp);
  if (!reachable) {
    return NextResponse.json(
      { error: "Sandbox is not running" },
      { status: 409 },
    );
  }

  try {
    const res = await execRemote(
      bootstrapLogCommand(),
      isLocal
        ? { container: sandbox.instanceId!, timeoutMs: 20_000 }
        : {
            host: sandbox.publicIp!,
            privateKeyPath: sandboxPrivateKeyPath(getConfig().dataDir),
            timeoutMs: 20_000,
          },
    );
    return NextResponse.json(parseBootstrapLog(res.stdout));
  } catch (err) {
    const message = err instanceof Error ? err.message : "SSH failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
