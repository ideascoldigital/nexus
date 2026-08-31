import { NextRequest, NextResponse } from "next/server";
import { listSandboxProcesses } from "@/lib/sandbox-process-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// GET — every process this sandbox can run, with live state.
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  try {
    const processes = await listSandboxProcesses(projectId, sandboxId);
    return NextResponse.json({ processes });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Could not list the processes";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
