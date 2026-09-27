/**
 * A thread operation as a Server-Sent Events stream (spec 30 phase 3): each
 * event is sent as soon as it is stored — the user's message, every read as
 * it completes, then the reply or the action card — and a final `done` frame
 * carries the whole thread. The model's reply itself arrives whole: the
 * agents SDK call behind a turn is not streamed.
 */

import type { EventSink } from "./threads";

export function sseResponse(run: (emit: EventSink) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        const thread = await run((e) => send("event", e));
        send("done", thread);
      } catch (err) {
        const status = (err as { status?: number }).status;
        send("failure", { error: err instanceof Error ? err.message : String(err), status: status ?? 500 });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}

export const wantsStream = (req: Request) => (req.headers.get("accept") ?? "").includes("text/event-stream");
