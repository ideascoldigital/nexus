import { NextRequest, NextResponse } from "next/server";
import { getProjectLink, saveProjectLink } from "@/services/github-projects";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;
    const link = await getProjectLink(projectId);
    return NextResponse.json(link);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const linkSchema = z.object({
  accountId: z.string().min(1),
  ghProjectId: z.string().min(1),
  title: z.string().min(1),
});

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const { projectId } = await params;
    const parsed = linkSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    await saveProjectLink(projectId, parsed.data);
    return NextResponse.json(parsed.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
