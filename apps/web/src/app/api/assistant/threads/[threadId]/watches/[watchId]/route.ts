import { NextRequest, NextResponse } from "next/server";

import { cancelWatch } from "@/lib/assistant/watches";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ threadId: string; watchId: string }> };

/** Stop watching (spec 30). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { threadId, watchId } = await params;
  if (!(await cancelWatch(threadId, watchId))) {
    return NextResponse.json({ error: "No open watch to cancel" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
