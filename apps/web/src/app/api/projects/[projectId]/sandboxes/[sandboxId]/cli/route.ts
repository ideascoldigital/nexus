import { NextRequest, NextResponse } from "next/server";
import { pushNexusCli } from "@/lib/sandbox-cli";

export const dynamic = "force-dynamic";
// Writing two files over ssh/docker exec; well inside the default, but the
// sandbox may be busy installing when this is called right after a boot.
export const maxDuration = 120;

type Params = { params: Promise<{ projectId: string; sandboxId: string }> };

// POST — (re)install the `nexus` CLI and refresh its manifest from the canvas.
export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId, sandboxId } = await params;

  const result = await pushNexusCli(projectId, sandboxId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
