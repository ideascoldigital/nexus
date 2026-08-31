import { NextRequest, NextResponse } from "next/server";
import {
  getIssuesForFeature,
  linkIssueToFeature,
  unlinkIssueFromFeature,
} from "@/services/github";
import { z } from "zod";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> }
) {
  try {
    const { featureId } = await params;
    const items = await getIssuesForFeature(featureId);
    return NextResponse.json(items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const linkSchema = z.object({ issueId: z.string().min(1) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> }
) {
  try {
    const { featureId } = await params;
    const body = await req.json();
    const parsed = linkSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const link = await linkIssueToFeature(featureId, parsed.data.issueId);
    return NextResponse.json(link, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> }
) {
  try {
    const { featureId } = await params;
    const issueId = req.nextUrl.searchParams.get("issueId");

    if (!issueId) {
      return NextResponse.json({ error: "issueId is required" }, { status: 400 });
    }

    await unlinkIssueFromFeature(featureId, issueId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
