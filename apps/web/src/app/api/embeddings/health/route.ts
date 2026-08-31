import { NextResponse } from "next/server";
import { checkEmbedderHealth } from "@nexux/embeddings/embedder";

export async function GET() {
  const health = await checkEmbedderHealth("ollama-nomic");
  return NextResponse.json(health);
}
