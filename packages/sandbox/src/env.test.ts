import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyGlobalSecrets,
  applyLlmCredentials,
  GLOBAL_ENV_SETTINGS,
  LLM_CREDENTIAL_ENV,
} from "./env";

// Pins the global-secrets → sandbox env contract (spec 16 extends the
// allowlist with OpenCode provider keys; these rules must survive that).

test("allowlisted keys map to their env vars", () => {
  const env = applyGlobalSecrets({}, [
    { key: "openai_api_key", value: "sk-openai" },
    { key: "anthropic_api_key", value: "sk-ant" },
  ]);
  assert.equal(env.OPENAI_API_KEY, "sk-openai");
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant");
});

test("non-allowlisted settings never leak into the sandbox", () => {
  const env = applyGlobalSecrets({}, [
    { key: "civo_api_key", value: "host-only" },
    { key: "telegram_bot_token", value: "host-only" },
    { key: "made_up_key", value: "nope" },
  ]);
  assert.deepEqual(env, {});
});

test("project env vars always win over global secrets", () => {
  const env = applyGlobalSecrets({ OPENAI_API_KEY: "project" }, [
    { key: "openai_api_key", value: "global" },
  ]);
  assert.equal(env.OPENAI_API_KEY, "project");
});

test("blank or null values are skipped", () => {
  const env = applyGlobalSecrets({}, [
    { key: "openai_api_key", value: "   " },
    { key: "anthropic_api_key", value: null },
  ]);
  assert.deepEqual(env, {});
});

test("ANTHROPIC_API_KEY is skipped when a Claude OAuth token is present", () => {
  // Otherwise the claude CLI prefers the API key and silently switches the
  // agent's auth/billing away from OAuth.
  const env = applyGlobalSecrets({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, [
    { key: "anthropic_api_key", value: "sk-ant" },
    { key: "openai_api_key", value: "sk-openai" },
  ]);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, "sk-openai", "only Anthropic is gated");
});

test("spec-16 provider keys are in the default allowlist", () => {
  const env = applyGlobalSecrets({}, [
    { key: "openrouter_api_key", value: "sk-or" },
    { key: "google_api_key", value: "sk-g" },
    { key: "xai_api_key", value: "sk-x" },
  ]);
  assert.equal(env.OPENROUTER_API_KEY, "sk-or");
  assert.equal(env.GEMINI_API_KEY, "sk-g");
  assert.equal(env.XAI_API_KEY, "sk-x");
});

// --- applyLlmCredentials ----------------------------------------------------

test("selected LLM credentials map provider → env var", () => {
  const env = applyLlmCredentials({}, [
    { provider: "openrouter", apiKey: "sk-or" },
    { provider: "google", apiKey: "sk-g" },
    { provider: "zai", apiKey: "glm-key" },
  ]);
  assert.equal(env.OPENROUTER_API_KEY, "sk-or");
  assert.equal(env.GEMINI_API_KEY, "sk-g");
  assert.equal(env.ZAI_API_KEY, "glm-key");
});

test("unknown providers and blank keys are skipped", () => {
  const env = applyLlmCredentials({}, [
    { provider: "civo", apiKey: "host-secret" },
    { provider: "openai", apiKey: "  " },
    { provider: "openrouter", apiKey: null },
  ]);
  assert.deepEqual(env, {});
});

test("existing env always wins over an LLM credential", () => {
  const env = applyLlmCredentials({ OPENAI_API_KEY: "project" }, [
    { provider: "openai", apiKey: "cred" },
  ]);
  assert.equal(env.OPENAI_API_KEY, "project");
});

test("explicit anthropic-key credential injects even with a Claude OAuth token", () => {
  // Unlike the global-settings fallback (skipped to protect claude's OAuth
  // auth), an explicitly selected credential is a deliberate choice — the
  // OpenCode brain needs it. buildSpec applies credentials before globals.
  const env = applyLlmCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, [
    { provider: "anthropic-key", apiKey: "sk-ant" },
  ]);
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant");
});

test("every LLM credential provider maps to a distinct env var", () => {
  const vars = Object.values(LLM_CREDENTIAL_ENV);
  assert.equal(new Set(vars).size, vars.length);
});

test("default allowlist stays host-safe: no civo/telegram entries", () => {
  for (const key of Object.keys(GLOBAL_ENV_SETTINGS)) {
    assert.ok(
      !/civo|telegram/.test(key),
      `provisioning/notification secret in sandbox allowlist: ${key}`,
    );
  }
});
