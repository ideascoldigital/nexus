import { NextRequest, NextResponse } from "next/server";

import { stackRunner } from "@/lib/stack/runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const status = await stackRunner.status(projectId);
  return NextResponse.json(status);
}
