import { NextRequest, NextResponse } from "next/server";

import { stackRunner } from "@/lib/stack/runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const result = await stackRunner.up(projectId);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, warnings: result.warnings },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: "starting",
    warnings: result.warnings,
  });
}
