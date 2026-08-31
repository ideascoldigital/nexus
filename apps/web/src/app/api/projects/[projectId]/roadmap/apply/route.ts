import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  composeAiRefinement,
  roadmapProposalSchema,
} from "@/services/roadmap-generator";

const applySchema = z.object({
  proposal: roadmapProposalSchema,
  // key → human title, echoed from /generate so aiRefinement cites titles.
  sectionTitles: z.record(z.string(), z.string()).default({}),
});

// Persists a reviewed/edited proposal: dev phases + their features, in one
// transaction. Discarded items simply aren't in the payload.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const parsed = applySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { proposal, sectionTitles } = parsed.data;

  const created = await prisma.$transaction(async (tx) => {
    const lastPhase = await tx.devPhase.findFirst({
      where: { projectId },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    const lastFeature = await tx.feature.findFirst({
      where: { projectId, status: "backlog" },
      orderBy: { order: "desc" },
      select: { order: true },
    });

    let phaseOrder = (lastPhase?.order ?? -1) + 1;
    let featureOrder = (lastFeature?.order ?? -1) + 1;
    let featureCount = 0;
    const phases = [];

    for (const p of proposal.phases) {
      const phase = await tx.devPhase.create({
        data: {
          projectId,
          name: p.name,
          goal: p.goal.trim() || null,
          order: phaseOrder++,
          sourceSectionKeys: p.sourceSectionKeys,
        },
      });
      for (const f of p.features) {
        await tx.feature.create({
          data: {
            projectId,
            devPhaseId: phase.id,
            title: f.title,
            description: f.description.trim() || null,
            priority: f.priority,
            status: "backlog",
            order: featureOrder++,
            sourceSectionKeys: f.sourceSectionKeys,
            aiRefinement: composeAiRefinement(
              f.acceptanceCriteria,
              f.sourceSectionKeys,
              sectionTitles
            ),
          },
        });
        featureCount++;
      }
      phases.push(phase);
    }

    return { phases, featureCount };
  });

  return NextResponse.json(created, { status: 201 });
}
