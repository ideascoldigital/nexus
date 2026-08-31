import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const reorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const parsed = reorderSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const phases = await prisma.devPhase.findMany({
    where: { projectId },
    select: { id: true },
  });
  const known = new Set(phases.map((p) => p.id));
  if (!parsed.data.orderedIds.every((id) => known.has(id))) {
    return NextResponse.json(
      { error: "Unknown dev phase in orderedIds" },
      { status: 400 }
    );
  }

  await prisma.$transaction(
    parsed.data.orderedIds.map((id, i) =>
      prisma.devPhase.update({ where: { id }, data: { order: i } })
    )
  );

  return NextResponse.json({ success: true });
}
