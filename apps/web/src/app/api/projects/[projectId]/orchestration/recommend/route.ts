import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recommendAgents, recommendSkills } from "@/services/skill-recommender";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

const schema = z.object({ kind: z.enum(["skills", "agents"]).default("skills") });

/** LLM-ranked skill/agent recommendations from the definition + code profile. */
export async function POST(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  try {
    const result =
      parsed.data.kind === "agents"
        ? await recommendAgents(projectId)
        : await recommendSkills(projectId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Recommendation failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
