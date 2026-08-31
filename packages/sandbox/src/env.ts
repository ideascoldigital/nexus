/**
 * Global Settings secrets that may flow into every sandbox — allowlisted
 * only. civo_api_key / telegram_* are provisioning/notification secrets and
 * must never leave the host machine.
 *
 * Maps Settings key → instance env var. This is the single place to extend
 * when a new agent brain (e.g. OpenCode) needs more provider keys.
 */
export const GLOBAL_ENV_SETTINGS: Record<string, string> = {
  openai_api_key: "OPENAI_API_KEY",
  anthropic_api_key: "ANTHROPIC_API_KEY",
  openrouter_api_key: "OPENROUTER_API_KEY",
  google_api_key: "GEMINI_API_KEY",
  xai_api_key: "XAI_API_KEY",
  zai_api_key: "ZAI_API_KEY",
};

/**
 * CloudCredential.provider → env var for saved LLM API keys (data.apiKey).
 * OpenCode picks these up natively; per-sandbox credentials beat the global
 * Settings fallback above, and project env vars beat both.
 */
export const LLM_CREDENTIAL_ENV: Record<string, string> = {
  "anthropic-key": "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  "xai-llm": "XAI_API_KEY",
  zai: "ZAI_API_KEY", // Z.ai (Zhipu GLM) — opencode model ids "zai/glm-*"
};

/** Providers selectable as named LLM credentials. */
export const LLM_CREDENTIAL_PROVIDERS = Object.keys(LLM_CREDENTIAL_ENV);

/**
 * Merge selected LLM credentials into the sandbox env, in place. Existing
 * values always win (project env vars and earlier-resolved tokens). Unknown
 * providers and blank keys are skipped.
 */
export function applyLlmCredentials(
  envVars: Record<string, string>,
  creds: Array<{ provider: string; apiKey: string | null | undefined }>,
): Record<string, string> {
  for (const cred of creds) {
    const envKey = LLM_CREDENTIAL_ENV[cred.provider];
    if (!envKey || !cred.apiKey?.trim() || envVars[envKey]) continue;
    envVars[envKey] = cred.apiKey;
  }
  return envVars;
}

export type GlobalSecretRow = { key: string; value: string | null };

/**
 * Merge allowlisted global secrets into a sandbox env-var map, in place.
 *
 * Rules (each covered by env.test.ts — keep them in sync):
 * - Only keys present in the allowlist are considered; anything else is
 *   ignored no matter what rows are passed in.
 * - Project env vars always win: an existing value is never overwritten.
 * - Blank/whitespace-only values are skipped.
 * - ANTHROPIC_API_KEY is skipped when a Claude Code OAuth token is present:
 *   the CLI would prefer the API key and silently switch the agent's
 *   auth/billing away from OAuth.
 */
export function applyGlobalSecrets(
  envVars: Record<string, string>,
  rows: GlobalSecretRow[],
  allowlist: Record<string, string> = GLOBAL_ENV_SETTINGS,
): Record<string, string> {
  for (const row of rows) {
    const envKey = allowlist[row.key];
    if (!envKey || !row.value?.trim() || envVars[envKey]) continue;
    if (envKey === "ANTHROPIC_API_KEY" && envVars.CLAUDE_CODE_OAUTH_TOKEN) {
      continue;
    }
    envVars[envKey] = row.value;
  }
  return envVars;
}
