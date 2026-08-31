import { NextRequest, NextResponse } from "next/server";

import { getStackInheritance } from "@/lib/stack/sandbox-inheritance";

type Params = { params: Promise<{ projectId: string }> };

/** What the sandbox config would inherit from the Stack canvas. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  return NextResponse.json(await getStackInheritance(projectId));
}
