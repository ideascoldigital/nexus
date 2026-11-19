import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { seedProjectStack } from "@/services/stack-seed";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  /**
   * Re-seed a canvas that already has nodes, replacing it.
   *
   * Explicit because the refusal exists for a reason: a merge cannot tell a
   * deliberate edit from a stale one, so the only honest options are "refuse"
   * and "replace, because you asked".
   */
  replace: z.boolean().optional(),
});

/** Spec 25 piece 1 — build a starting canvas from the project's repos. */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const result = await seedProjectStack(projectId, {
      replace: parsed.data.replace,
    });
    // A refusal is an answer, not a failure: the caller gets the reason and
    // decides whether to pass `replace`.
    return NextResponse.json(result, { status: result.written ? 200 : 409 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Seeding failed" },
      { status: 500 },
    );
  }
}
