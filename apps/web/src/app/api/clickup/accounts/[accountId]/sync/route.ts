import { NextRequest, NextResponse } from "next/server";
import { syncTasks } from "@/services/clickup";
import { z } from "zod";

const syncSchema = z.object({
  teamId: z.string().min(1),
  listId: z.string().min(1),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const { accountId } = await params;
    const parsed = syncSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const result = await syncTasks(accountId, parsed.data.teamId, parsed.data.listId);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
