import { NextRequest, NextResponse } from "next/server";

import { stackRunner } from "@/lib/stack/runner";
import type { StackLogLine } from "@/lib/stack/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const url = new URL(req.url);

  // Polling mode (agents): ?since=<seq>
  if (url.searchParams.get("stream") !== "1") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    return NextResponse.json(stackRunner.getLogs(projectId, since));
  }

  // Streaming mode (UI): ndjson, replay buffer then follow
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (line: StackLogLine) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        } catch {
          // stream closed
        }
      };
      for (const line of stackRunner.getLogs(projectId)) send(line);
      unsubscribe = stackRunner.subscribe(projectId, send);
      // keep proxies from buffering / closing the idle connection
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          // stream closed
        }
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
