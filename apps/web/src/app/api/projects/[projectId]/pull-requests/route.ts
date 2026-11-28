import { NextRequest, NextResponse } from "next/server";

import { projectPullRequests } from "@/lib/project-prs";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/** The project's recent pull/merge requests across its repositories (spec 39). */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return NextResponse.json(await projectPullRequests(projectId));
}
