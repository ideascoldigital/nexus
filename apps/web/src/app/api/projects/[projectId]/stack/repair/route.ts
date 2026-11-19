import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { MAX_REPAIR_ROUNDS, repairProjectStack } from "@/services/stack-repair";

export const dynamic = "force-dynamic";
// Each round runs a validation, which may provision a container.
export const maxDuration = 300;

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  maxRounds: z.number().int().min(1).max(MAX_REPAIR_ROUNDS).optional(),
});

/**
 * Spec 25 piece 2 — repair the stack until validation passes, or give up.
 *
 * There is no "propose" mode here: `POST /stack/validate` already is it. It
 * reports what is wrong and changes nothing, which is exactly what a dry
 * proposal would be — and a second endpoint that ran the agent without
 * applying would spend a validation to produce advice the user cannot act on
 * without re-running everything anyway.
 *
 * So this endpoint writes, and answers with the diff of what it wrote.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await repairProjectStack(projectId, { maxRounds: parsed.data.maxRounds }),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Repair failed" },
      { status: 500 },
    );
  }
}
