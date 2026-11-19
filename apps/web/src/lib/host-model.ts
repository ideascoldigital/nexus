// Which model the host's own agents run on.
//
// Nexus has been multi-provider everywhere except here. Sandboxes fan six LLM
// credentials out as env vars (`LLM_CREDENTIAL_ENV`), the brain picker offers
// Claude or OpenCode — and then every agent that runs *on the host* (the stack
// assistant, the repair loop, the roadmap generator, the skill recommender)
// hardcoded `modelProvider: "openai"` and read a single `openai_api_key`
// setting. A user holding an Anthropic key and no OpenAI one was told to "add
// it in Settings", which read as a missing configuration and was really a
// default nobody had parameterised.
//
// The SDK was never the constraint: `defineAgent` takes provider, model and
// key per call, and ships 75 providers including every one Nexus already
// stores. So this resolves the same credentials the rest of the product does.

import { prisma } from "@nexux/db";

import { getWorkspaceSetting } from "@/lib/workspace";

/**
 * Nexus credential provider → the SDK's provider id.
 *
 * Mostly identity; the two exceptions are historical names on our side
 * (`anthropic-key`, `xai-llm`) and Google's, which the SDK calls `gemini`.
 * A provider absent from this map cannot drive a host agent — `claude` is the
 * clearest case: it holds an OAuth token for the Claude Code CLI, which is not
 * an API key and is not something this SDK can send.
 */
export const HOST_MODEL_PROVIDERS: Record<string, string> = {
  openai: "openai",
  "anthropic-key": "anthropic",
  openrouter: "openrouter",
  google: "gemini",
  "xai-llm": "xai",
  zai: "zai",
};

/**
 * The model used when a provider is selected without naming one.
 *
 * Deliberately a current, capable model per provider rather than the cheapest:
 * these agents read repositories and propose configuration changes, and a
 * weaker model produces suggestions that cost more to review than to write.
 */
const DEFAULT_MODEL: Record<string, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini/gemini-2.0-flash",
  xai: "xai/grok-3",
  openrouter: "openrouter/anthropic/claude-sonnet-4",
  zai: "zai/glm-4.5",
};

export type HostModel = {
  /** SDK provider id, e.g. "anthropic". */
  provider: string;
  modelName: string;
  apiKey: string;
  /** Which saved credential this came from, for the error messages. */
  credentialName: string;
};

/** The settings key naming the preferred credential, if the user set one. */
export const HOST_MODEL_SETTING = "host_model_credential_id";
/** Optional override for the model name, alongside the credential. */
export const HOST_MODEL_NAME_SETTING = "host_model_name";

function keyFrom(data: unknown): string | null {
  const d = (data ?? {}) as { apiKey?: unknown; token?: unknown };
  const raw = typeof d.apiKey === "string" ? d.apiKey : d.token;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * Resolves the model a host agent should use, or null when nothing can.
 *
 * Order: the credential the user chose → any usable saved credential →
 * the legacy `openai_api_key` setting. The legacy path stays because it is
 * what every existing install is configured with, and breaking those to
 * introduce a choice would be a poor trade.
 *
 * Returns null rather than throwing: the caller phrases the error, and it is
 * the caller that knows whether this is a background job or something a user
 * is waiting on.
 */
export type HostModelSources = {
  setting(key: string): Promise<string | null>;
  credentialById(id: string): Promise<CredentialRow | null>;
  credentials(): Promise<CredentialRow[]>;
};

export type CredentialRow = {
  id: string;
  name: string;
  provider: string;
  data: unknown;
};

/**
 * The resolution rules, over injected sources.
 *
 * Split from the database so the precedence — chosen, then any usable, then
 * the legacy setting — is testable without one. That ordering is the whole of
 * this module's behaviour, and it is easy to get subtly wrong.
 */
export async function resolveHostModelFrom(
  sources: HostModelSources,
): Promise<HostModel | null> {
  const chosenId = (await sources.setting(HOST_MODEL_SETTING))?.trim();
  const modelOverride = (await sources.setting(HOST_MODEL_NAME_SETTING))?.trim();

  const usable = (cred: CredentialRow) =>
    Boolean(HOST_MODEL_PROVIDERS[cred.provider]) && Boolean(keyFrom(cred.data));

  const build = (cred: CredentialRow): HostModel => {
    const provider = HOST_MODEL_PROVIDERS[cred.provider];
    return {
      provider,
      modelName: modelOverride || DEFAULT_MODEL[provider] || DEFAULT_MODEL.openai,
      apiKey: keyFrom(cred.data)!,
      credentialName: cred.name,
    };
  };

  // 1. The credential the user picked. One that has since been deleted or had
  //    its key removed falls through rather than failing: the intent was "use
  //    a model", and doing nothing would serve it worse than using another.
  if (chosenId) {
    const cred = await sources.credentialById(chosenId);
    if (cred && usable(cred)) return build(cred);
  }

  // 2. Any usable saved credential, oldest first — a stable answer across
  //    calls rather than one that depends on which was touched last.
  for (const cred of await sources.credentials()) {
    if (usable(cred)) return build(cred);
  }

  // 3. The legacy single setting every existing install is configured with.
  //    Kept because breaking those to introduce a choice is a poor trade.
  const legacy = (await sources.setting("openai_api_key"))?.trim();
  if (legacy) {
    return {
      provider: "openai",
      modelName: modelOverride || DEFAULT_MODEL.openai,
      apiKey: legacy,
      credentialName: "openai_api_key (Settings)",
    };
  }

  return null;
}

export async function resolveHostModel(
  workspaceId?: string,
): Promise<HostModel | null> {
  const ws = workspaceId;

  return resolveHostModelFrom({
    setting: async (key) => {
      const row = ws
        ? await getWorkspaceSetting(ws, key)
        : await prisma.settings.findFirst({ where: { key, isActive: true } });
      return row?.value ?? null;
    },
    credentialById: (id) => prisma.cloudCredential.findUnique({ where: { id } }),
    credentials: () =>
      prisma.cloudCredential.findMany({
        where: {
          provider: { in: Object.keys(HOST_MODEL_PROVIDERS) },
          ...(ws ? { workspaceId: ws } : {}),
        },
        orderBy: { createdAt: "asc" },
      }),
  });
}

/**
 * What to tell a user who has no usable model.
 *
 * Names every provider that would work, because the old message named exactly
 * one and sent people looking for an OpenAI key they may have had no reason to
 * own.
 */
export function noHostModelMessage(): string {
  return (
    "No LLM credential is configured for host agents. Add one in Settings — " +
    "OpenAI, Anthropic, OpenRouter, Google, xAI or Z.ai all work."
  );
}
