import { NextRequest, NextResponse } from "next/server";
import { checkSandboxHealth } from "@/lib/task-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// Remote readiness probe: SSH reachable, bootstrap finished, repo cloned,
// Claude Code installed + authenticated, plus the repo's dirty files.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    const health = await checkSandboxHealth(projectId, sandboxId);
    return NextResponse.json(health);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Health check failed";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
