import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { proposeStack } from "@/services/stack-proposal";

export const dynamic = "force-dynamic";
// The agent reads repo files and may call several tools before answering.
export const maxDuration = 120;

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.object({
  request: z.string().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .max(20)
    .optional(),
});

/**
 * "Here is what I need" → proposed stack nodes.
 *
 * Read-only: it proposes and changes nothing. The canvas applies a suggestion
 * when the user taps Apply, through the same path the side panel uses — so
 * there is one place where an agent's proposal becomes a write, and it is the
 * one the user drives.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await proposeStack(projectId, parsed.data.request, parsed.data.history),
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Proposal failed" },
      { status: 500 },
    );
  }
}
