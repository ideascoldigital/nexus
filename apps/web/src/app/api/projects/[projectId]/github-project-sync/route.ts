import { NextRequest, NextResponse } from "next/server";
import { syncProjectV2 } from "@/services/github-projects";

/** Re-pull the linked GitHub board and move imported features accordingly. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const result = await syncProjectV2(projectId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not linked") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
