import { NextRequest, NextResponse } from "next/server";

import { stackRunner } from "@/lib/stack/runner";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function POST(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  await stackRunner.down(projectId);
  return NextResponse.json({ ok: true });
}
