import { NextRequest, NextResponse } from "next/server";
import { syncIssues } from "@/services/github";
import { z } from "zod";

const syncSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  state: z.enum(["open", "closed", "all"]).default("all"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const body = await req.json();
    const parsed = syncSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const result = await syncIssues(
      accountId,
      parsed.data.owner,
      parsed.data.repo,
      parsed.data.state
    );

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
