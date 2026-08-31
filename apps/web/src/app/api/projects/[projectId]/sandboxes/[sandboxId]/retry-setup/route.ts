import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { retrySandboxSetup } from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/**
 * Re-run the repo half of the bootstrap: clone what is missing, install, build.
 *
 * Safe to repeat — an existing checkout is adopted rather than re-cloned — so
 * the honest answer to a partial failure is "press it again", not "recreate the
 * machine and hope the timing works out".
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const sandbox = await prisma.sandbox.findFirst({
    where: { id: sandboxId, projectId },
    select: { id: true, status: true, provider: true, instanceId: true, publicIp: true },
  });
  if (!sandbox) {
    return NextResponse.json({ error: "Sandbox not found" }, { status: 404 });
  }
  const reachable =
    sandbox.provider === "local"
      ? Boolean(sandbox.instanceId)
      : sandbox.status === "running" && Boolean(sandbox.publicIp);
  if (!reachable) {
    return NextResponse.json(
      { error: "Sandbox is not reachable yet" },
      { status: 409 },
    );
  }

  try {
    return NextResponse.json(await retrySandboxSetup(sandboxId));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retry failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
