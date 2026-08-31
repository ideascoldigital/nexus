import { NextResponse } from "next/server";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getWorkspaceMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/** The active workspace's pulse — spend, runs, PRs, machines, review queue. */
export async function GET() {
  const workspaceId = await getActiveWorkspaceId();
  return NextResponse.json(await getWorkspaceMetrics(workspaceId));
}
