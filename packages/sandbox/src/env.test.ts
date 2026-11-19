import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyGlobalSecrets,
  applyLlmCredentials,
  GLOBAL_ENV_SETTINGS,
  LLM_CREDENTIAL_ENV,
  LLM_CREDENTIAL_PROVIDERS,
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

// --- Precedence between the two sources --------------------------------------
// Both write the same env vars. The documented order is project env > named
// credential > global setting, and it holds only because each function refuses
// to overwrite. Tested together because neither function alone shows it.

test("a named credential beats the global setting for the same var", () => {
  // Resolution order in the caller: credentials first, then globals. If
  // applyGlobalSecrets overwrote, picking a per-sandbox key would silently
  // fall back to the account-wide one.
  const envVars = applyLlmCredentials({}, [
    { provider: "openai", apiKey: "from-credential" },
  ]);
  applyGlobalSecrets(envVars, [
    { key: "openai_api_key", value: "from-global" },
  ]);
  assert.equal(envVars.OPENAI_API_KEY, "from-credential");
});

test("a project env var beats both a credential and a global", () => {
  const envVars: Record<string, string> = { OPENAI_API_KEY: "from-project" };
  applyLlmCredentials(envVars, [
    { provider: "openai", apiKey: "from-credential" },
  ]);
  applyGlobalSecrets(envVars, [
    { key: "openai_api_key", value: "from-global" },
  ]);
  assert.equal(envVars.OPENAI_API_KEY, "from-project");
});

// --- The in-place contract ---------------------------------------------------
// Both merge into the caller's map and return it. Callers chain them on one
// object, so returning a copy would drop whichever result was not reassigned.

test("applyGlobalSecrets mutates and returns the same map", () => {
  const envVars: Record<string, string> = {};
  const returned = applyGlobalSecrets(envVars, [
    { key: "openai_api_key", value: "sk-1" },
  ]);
  assert.equal(returned, envVars);
  assert.equal(envVars.OPENAI_API_KEY, "sk-1");
});

test("applyLlmCredentials mutates and returns the same map", () => {
  const envVars: Record<string, string> = {};
  const returned = applyLlmCredentials(envVars, [
    { provider: "openai", apiKey: "sk-1" },
  ]);
  assert.equal(returned, envVars);
  assert.equal(envVars.OPENAI_API_KEY, "sk-1");
});

test("no rows and no credentials leave the map untouched", () => {
  assert.deepEqual(applyGlobalSecrets({}, []), {});
  assert.deepEqual(applyLlmCredentials({}, []), {});
});

// --- Duplicates --------------------------------------------------------------
// Two rows can name the same env var. Since neither function overwrites, the
// first wins — worth pinning so the resolution stays order-defined rather than
// depending on which row the query happened to return last.

test("the first of two rows for one var wins", () => {
  const envVars = applyGlobalSecrets({}, [
    { key: "openai_api_key", value: "first" },
    { key: "openai_api_key", value: "second" },
  ]);
  assert.equal(envVars.OPENAI_API_KEY, "first");
});

test("the first of two credentials for one provider wins", () => {
  const envVars = applyLlmCredentials({}, [
    { provider: "openai", apiKey: "first" },
    { provider: "openai", apiKey: "second" },
  ]);
  assert.equal(envVars.OPENAI_API_KEY, "first");
});

// --- Values are passed through unchanged -------------------------------------

test("a value is written verbatim, padding included", () => {
  // Only the blank check trims; the stored value is not rewritten. Trimming
  // here would silently alter a key whose format we do not own.
  const envVars = applyGlobalSecrets({}, [
    { key: "openai_api_key", value: "  sk-pad  " },
  ]);
  assert.equal(envVars.OPENAI_API_KEY, "  sk-pad  ");
});

test("an undefined apiKey is skipped like a blank one", () => {
  assert.deepEqual(
    applyLlmCredentials({}, [{ provider: "openai", apiKey: undefined }]),
    {},
  );
});

// --- LLM_CREDENTIAL_PROVIDERS ------------------------------------------------
// The list the credential picker offers. Derived from the env map, so the two
// cannot drift — but only while it stays derived.

test("the selectable providers are exactly the mapped ones", () => {
  assert.deepEqual(
    [...LLM_CREDENTIAL_PROVIDERS].sort(),
    Object.keys(LLM_CREDENTIAL_ENV).sort(),
  );
});

test("every selectable provider resolves to an env var", () => {
  // A provider offered in the UI that maps to nothing is silently a no-op:
  // the sandbox starts with no key and the agent fails at first call.
  for (const provider of LLM_CREDENTIAL_PROVIDERS) {
    assert.ok(LLM_CREDENTIAL_ENV[provider], `${provider} maps to nothing`);
  }
});

// --- The allowlist is the boundary -------------------------------------------

test("each allowlisted setting maps to a distinct env var", () => {
  // Two settings sharing one var makes which key reaches the sandbox depend on
  // row order rather than on what was configured.
  const vars = Object.values(GLOBAL_ENV_SETTINGS);
  assert.equal(new Set(vars).size, vars.length);
});

test("an empty allowlist lets nothing through", () => {
  // The allowlist is the whole boundary: with none, no row may pass.
  assert.deepEqual(
    applyGlobalSecrets({}, [{ key: "openai_api_key", value: "sk-1" }], {}),
    {},
  );
});

test("a caller-supplied allowlist replaces the default, not extends it", () => {
  // Passing a narrow allowlist must not still admit the default entries.
  const envVars = applyGlobalSecrets(
    {},
    [
      { key: "openai_api_key", value: "sk-1" },
      { key: "xai_api_key", value: "sk-2" },
    ],
    { xai_api_key: "XAI_API_KEY" },
  );
  assert.deepEqual(envVars, { XAI_API_KEY: "sk-2" });
});
