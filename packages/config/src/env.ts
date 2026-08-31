import path from "path";
import { MODE, type Mode } from "./mode";
import { homeDir } from "./paths";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export interface LLMConfig {
  ollamaUrl: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export interface IntegrationsConfig {
  codexApiUrl: string;
  agentsGeneratorApiUrl: string;
}

export interface ShellConfig {
  home: string;
}

export interface NexuxConfig {
  readonly mode: Mode;
  readonly dataDir: string;
  /**
   * Root directory for repository checkouts on *this* machine.
   *
   * A Nexus host sets `NEXUX_WORKSPACE_ROOT` to the writable volume its compose
   * file mounts; a local install has no such volume and uses a folder in the
   * user's home. Never guess a path outside these: a host's container runs as an
   * unprivileged uid, so anything it did not declare is root-owned and unwritable.
   */
  readonly workspaceRoot: string;
  readonly databaseUrl: string;
  readonly encryptionKey?: string;
  readonly llm: LLMConfig;
  readonly integrations: IntegrationsConfig;
  readonly shell: ShellConfig;
}

// Lazy getter object — each property reads env on access.
// Lets callers use only the slice they need without tripping required() checks
// on unrelated vars.
const home = homeDir();

const config: NexuxConfig = {
  mode: MODE,
  get dataDir() {
    return optional("NEXUX_DATA_DIR", path.join(home, ".nexux"))!;
  },
  get workspaceRoot() {
    return optional("NEXUX_WORKSPACE_ROOT", path.join(home, "nexux-workspace"))!;
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get encryptionKey() {
    return optional("ENCRYPTION_KEY");
  },
  get llm(): LLMConfig {
    return {
      ollamaUrl: optional("OLLAMA_URL", "http://localhost:11434")!,
      anthropicApiKey: optional("ANTHROPIC_API_KEY"),
      openaiApiKey: optional("OPENAI_API_KEY") ?? optional("OPENAPI_KEY"),
    };
  },
  get integrations(): IntegrationsConfig {
    return {
      codexApiUrl: optional("CODEX_API_URL", "https://api.codex.com/v1")!,
      agentsGeneratorApiUrl: optional(
        "AGENTS_GENERATOR_API_URL",
        "https://api.agentsgenerator.dev",
      )!,
    };
  },
  // Which *shell* to run is not a machine-wide constant — Windows has cmd,
  // PowerShell and one per WSL distro, and a session picks among them. That
  // lives in `@nexux/terminal`'s `shells.ts`, which can enumerate them; this
  // config only answers where the user's home is.
  get shell(): ShellConfig {
    return { home };
  },
};

export function getConfig(): NexuxConfig {
  return config;
}
