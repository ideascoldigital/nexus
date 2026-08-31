import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getGitLabIssuesForFeature,
  linkGitLabIssueToFeature,
  unlinkGitLabIssueFromFeature,
} from "@/services/gitlab";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> },
) {
  try {
    const { featureId } = await params;
    return NextResponse.json(await getGitLabIssuesForFeature(featureId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const linkSchema = z.object({ issueId: z.string().min(1) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> },
) {
  try {
    const { featureId } = await params;
    const parsed = linkSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const link = await linkGitLabIssueToFeature(featureId, parsed.data.issueId);
    return NextResponse.json(link, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> },
) {
  try {
    const { featureId } = await params;
    const issueId = req.nextUrl.searchParams.get("issueId");
    if (!issueId) {
      return NextResponse.json(
        { error: "issueId is required" },
        { status: 400 },
      );
    }

    await unlinkGitLabIssueFromFeature(featureId, issueId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
