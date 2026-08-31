import { prisma } from "@nexux/db";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { FEATURE_PRIORITIES, FEATURE_STATUSES } from "@nexux/core/enums";
import { importFeatures } from "@/lib/feature-import";

const featureSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  priority: z.enum(FEATURE_PRIORITIES),
  status: z.enum(FEATURE_STATUSES),
  // GitHubIssue cache row id — provenance link; null for hand-added rows.
  issueId: z.string().nullable().default(null),
});

const importSchema = z.object({
  phases: z
    .array(
      z.object({
        name: z.string().min(1),
        goal: z.string().default(""),
        createPhase: z.boolean().default(true),
        features: z.array(featureSchema).min(1),
      })
    )
    .min(1),
});

// Persists a reviewed GitHub-issues import: dev phases + features in one
// transaction (see lib/feature-import). Each imported feature keeps a
// FeatureIssue link back to the issue it came from.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const parsed = importSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const created = await importFeatures(
    projectId,
    parsed.data.phases.map((p) => ({
      ...p,
      features: p.features.map(({ issueId, ...f }) => ({
        ...f,
        externalId: issueId,
      })),
    })),
    "github"
  );

  return NextResponse.json(created, { status: 201 });
}
