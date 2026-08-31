import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@nexux/db";
import { getProjectBrain, setProjectBrain } from "@/services/brains";

// The body reaches prisma.upsert directly, so it is pinned to the three
// columns ProjectBrain actually has rather than passed through.
const putSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const brain = await getProjectBrain(projectId);
  return NextResponse.json(brain);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { provider, model, config } = parsed.data;
  const brain = await setProjectBrain(projectId, {
    provider,
    model,
    ...(config !== undefined && { config: config as Prisma.InputJsonValue }),
  });
  return NextResponse.json(brain);
}
