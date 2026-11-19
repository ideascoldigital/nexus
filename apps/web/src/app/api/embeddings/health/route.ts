import { NextResponse } from "next/server";
import { checkEmbedderHealth } from "@nexux/embeddings/embedder";

import { activeOllamaHost } from "@/lib/ollama-host";

export const dynamic = "force-dynamic";

export async function GET() {
  // hostSource tells Settings which knob set the address it shows.
  const { host, source } = await activeOllamaHost();
  const health = await checkEmbedderHealth("ollama-nomic", host);
  return NextResponse.json({ ...health, hostSource: source });
}
