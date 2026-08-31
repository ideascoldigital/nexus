import { NextRequest, NextResponse } from "next/server";

import { stackRunner } from "@/lib/stack/runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Run the canvas's install and build phases. Separate from `up` on purpose:
 * these can take minutes, while Up is meant to start what is already prepared.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const result = await stackRunner.prepare(projectId);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, warnings: result.warnings },
      { status: 503 }
    );
  }

  return NextResponse.json({
    ok: true,
    status: "preparing",
    warnings: result.warnings,
  });
}
