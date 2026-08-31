import { NextRequest, NextResponse } from "next/server";
import {
  getTasksForFeature,
  linkTaskToFeature,
  unlinkTaskFromFeature,
} from "@/services/clickup";
import { z } from "zod";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> }
) {
  try {
    const { featureId } = await params;
    const items = await getTasksForFeature(featureId);
    return NextResponse.json(items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const linkSchema = z.object({ taskId: z.string().min(1) });

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; featureId: string }> }
) {
  try {
    const { featureId } = await params;
    const parsed = linkSchema.safeParse(await req.json());

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const link = await linkTaskToFeature(featureId, parsed.data.taskId);
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
    const taskId = req.nextUrl.searchParams.get("taskId");

    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }

    await unlinkTaskFromFeature(featureId, taskId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
