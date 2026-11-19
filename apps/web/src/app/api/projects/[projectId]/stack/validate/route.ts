import { NextResponse } from "next/server";

import { validateProject } from "@/services/stack-validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Spec 24 piece 4 — "would this boot?".
 *
 * POST rather than GET: reading the observed half opens an SSH connection to
 * the project's sandbox, which is too expensive to sit behind something a
 * browser may prefetch or a proxy may cache.
 */
export async function POST(_req: Request, { params }: Params) {
  const { projectId } = await params;
  try {
    return NextResponse.json(await validateProject(projectId));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Validation failed" },
      { status: 500 },
    );
  }
}
