import { getOllamaPullStream } from "@nexux/embeddings/embedder";

export const runtime = "nodejs";

export async function POST() {
  try {
    const stream = await getOllamaPullStream();
    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of stream) {
            controller.enqueue(encoder.encode(JSON.stringify(part) + "\n"));
          }
          controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + "\n"));
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : "Pull failed";
          controller.enqueue(encoder.encode(JSON.stringify({ error: message }) + "\n"));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cannot start pull";
    return new Response(JSON.stringify({ error: message }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}
