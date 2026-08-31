import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { refreshTailscaleSession } from "@/lib/sandbox-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

/**
 * Re-run the tailnet join and hand back the URL a human has to approve.
 *
 * A POST rather than a GET: it starts `tailscale up` on the machine. It is
 * safe to repeat — an already-registered node just reports its address — which
 * is the point, since the bootstrap's one announcement of this URL scrolls out
 * of the log tail long before most people go looking for it.
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
  // A local container is exec-able as soon as it exists; a cloud instance
  // needs sshd, which means running with an address.
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
    return NextResponse.json(await refreshTailscaleSession(sandboxId));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Tailscale login failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
