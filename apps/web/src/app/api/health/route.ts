import { NextResponse } from "next/server";
import { checkEmbedderHealth } from "@nexux/embeddings/embedder";
import { activeOllamaHost } from "@/lib/ollama-host";
import { getSandboxReadiness } from "@/lib/sandbox-manager";
import { isTelegramConfigured } from "@/lib/telegram";
import { isSlackConfigured } from "@/lib/slack";

export const dynamic = "force-dynamic";

// Global health strip (design M5): one call, four dots.
export async function GET() {
  const [embedder, sandbox, telegram, slack] = await Promise.all([
    activeOllamaHost()
      .then(({ host }) => checkEmbedderHealth("ollama-nomic", host))
      .catch(() => null),
    getSandboxReadiness().catch(() => null),
    isTelegramConfigured().catch(() => false),
    isSlackConfigured().catch(() => false),
  ]);

  return NextResponse.json({
    ollama: Boolean(embedder?.ollamaReachable && embedder?.modelPresent),
    terraform: Boolean(sandbox?.terraformInstalled),
    civo: Boolean(sandbox?.hasCivoToken),
    telegram,
    slack,
  });
}
