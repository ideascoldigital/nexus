import { Ollama } from "ollama";
import { getConfig } from "@nexux/config";

export type EmbeddingProvider =
  | "ollama-nomic"
  | "local-minilm"
  | "openai-3-small"
  | "openai-3-large";

export type EmbedderConfig = {
  provider: EmbeddingProvider;
  ollamaHost?: string;
};

export type EmbedResult = {
  vector: number[];
  dimensions: number;
};

const PROVIDER_DIMS: Record<EmbeddingProvider, number> = {
  "ollama-nomic": 768,
  "local-minilm": 384,
  "openai-3-small": 1536,
  "openai-3-large": 3072,
};

const OLLAMA_MODEL = "nomic-embed-text";
const DEFAULT_HOST = getConfig().llm.ollamaUrl;
// nomic-embed-text context = 8192 tokens. Worst case ~1.5 chars/token (code, base64) → cap at 8000 chars hard.
const MAX_EMBED_CHARS = 8000;
const MIN_EMBED_CHARS = 200;

export class OllamaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailableError";
  }
}

export function dimensionsFor(provider: EmbeddingProvider): number {
  return PROVIDER_DIMS[provider];
}

export class Embedder {
  private ollama: Ollama;
  readonly provider: EmbeddingProvider;
  readonly dimensions: number;

  constructor(config: EmbedderConfig) {
    this.provider = config.provider;
    this.dimensions = PROVIDER_DIMS[config.provider];
    this.ollama = new Ollama({ host: config.ollamaHost ?? DEFAULT_HOST });
  }

  async ensureReady(): Promise<void> {
    if (this.provider !== "ollama-nomic") {
      throw new Error(`Provider ${this.provider} not implemented yet`);
    }

    let list;
    try {
      list = await this.ollama.list();
    } catch (err) {
      throw new OllamaUnavailableError(
        `Cannot reach Ollama at ${DEFAULT_HOST}. Install from https://ollama.com/download and start the daemon.`
      );
    }

    const present = list.models.some((m) => m.name.startsWith(OLLAMA_MODEL));
    if (!present) {
      await this.ollama.pull({ model: OLLAMA_MODEL });
    }
  }

  async embed(text: string): Promise<EmbedResult> {
    if (this.provider !== "ollama-nomic") {
      throw new Error(`Provider ${this.provider} not implemented yet`);
    }
    let candidate = text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;

    while (true) {
      try {
        const res = await this.ollama.embeddings({
          model: OLLAMA_MODEL,
          prompt: candidate,
        });
        return { vector: res.embedding, dimensions: res.embedding.length };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const overflow = /context length|exceeds the context/i.test(msg);
        if (!overflow || candidate.length <= MIN_EMBED_CHARS) throw err;
        candidate = candidate.slice(0, Math.max(MIN_EMBED_CHARS, Math.floor(candidate.length / 2)));
      }
    }
  }

  async embedBatch(texts: string[]): Promise<EmbedResult[]> {
    const out: EmbedResult[] = [];
    for (const t of texts) {
      out.push(await this.embed(t));
    }
    return out;
  }
}

export function getEmbedder(provider: EmbeddingProvider = "ollama-nomic"): Embedder {
  return new Embedder({ provider });
}

export type EmbedderHealth = {
  provider: EmbeddingProvider;
  ollamaReachable: boolean;
  modelPresent: boolean;
  modelName: string;
  host: string;
  error?: string;
};

export async function checkEmbedderHealth(
  provider: EmbeddingProvider = "ollama-nomic",
): Promise<EmbedderHealth> {
  const host = DEFAULT_HOST;
  const base: EmbedderHealth = {
    provider,
    ollamaReachable: false,
    modelPresent: false,
    modelName: OLLAMA_MODEL,
    host,
  };
  if (provider !== "ollama-nomic") {
    return { ...base, error: `Provider ${provider} not implemented yet` };
  }
  const client = new Ollama({ host });
  try {
    const list = await client.list();
    return {
      ...base,
      ollamaReachable: true,
      modelPresent: list.models.some((m) => m.name.startsWith(OLLAMA_MODEL)),
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : "Ollama unreachable",
    };
  }
}

export function getOllamaPullStream(host = DEFAULT_HOST) {
  const client = new Ollama({ host });
  return client.pull({ model: OLLAMA_MODEL, stream: true });
}
