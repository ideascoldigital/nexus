import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import {
  EmptyDefinitionError,
  RoadmapParseError,
  generateRoadmapProposal,
} from "@/services/roadmap-generator";

export const dynamic = "force-dynamic";

// Reads the definition and returns an AI roadmap proposal. Persists nothing —
// the client reviews/edits and then POSTs the result to ../apply.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const { proposal, sectionTitles } = await generateRoadmapProposal(projectId);
    return NextResponse.json({ proposal, sectionTitles });
  } catch (err) {
    if (err instanceof EmptyDefinitionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof RoadmapParseError) {
      return NextResponse.json(
        { error: err.message, raw: err.raw },
        { status: 422 }
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    // "OpenAI API key not configured" from createAgentClient lands here.
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
