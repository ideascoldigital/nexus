// host-model imports @nexux/db, which builds its client at module load and
// throws without DATABASE_URL. Nothing here queries it — the rules are
// exercised over injected sources.
import "@/services/services.test-setup";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  noHostModelMessage,
  resolveHostModelFrom,
  HOST_MODEL_PROVIDERS,
  HOST_MODEL_SETTING,
  HOST_MODEL_NAME_SETTING,
  type CredentialRow,
  type HostModelSources,
} from "./host-model";

function sources(over: {
  settings?: Record<string, string>;
  credentials?: CredentialRow[];
}): HostModelSources {
  const settings = over.settings ?? {};
  const credentials = over.credentials ?? [];
  return {
    setting: async (key) => settings[key] ?? null,
    credentialById: async (id) => credentials.find((c) => c.id === id) ?? null,
    credentials: async () =>
      credentials.filter((c) => HOST_MODEL_PROVIDERS[c.provider]),
  };
}

const cred = (over: Partial<CredentialRow> = {}): CredentialRow => ({
  id: "c1",
  name: "my key",
  provider: "openai",
  data: { apiKey: "sk-test" },
  ...over,
});

test("no credential and no legacy setting resolves to nothing", async () => {
  assert.equal(await resolveHostModelFrom(sources({})), null);
});

test("the message names every provider that would work", async () => {
  // The old one named exactly one, which sent people looking for an OpenAI key
  // they may have had no reason to own.
  const msg = noHostModelMessage();
  for (const name of ["OpenAI", "Anthropic", "OpenRouter", "Google", "xAI", "Z.ai"]) {
    assert.ok(msg.includes(name), `the message does not mention ${name}`);
  }
});

test("an Anthropic key alone is enough", async () => {
  // The case that started this: a user with no OpenAI key was told to add one.
  const model = await resolveHostModelFrom(
    sources({
      credentials: [
        cred({ provider: "anthropic-key", data: { apiKey: "sk-ant-x" }, name: "claude" }),
      ],
    }),
  );
  assert.equal(model?.provider, "anthropic");
  assert.equal(model?.apiKey, "sk-ant-x");
  assert.match(model!.modelName, /^claude-/);
});

test("our provider names are mapped to the SDK's", async () => {
  // `google` is `gemini` there, and two of ours carry historical suffixes.
  for (const [ours, theirs] of [
    ["anthropic-key", "anthropic"],
    ["xai-llm", "xai"],
    ["google", "gemini"],
    ["zai", "zai"],
    ["openrouter", "openrouter"],
  ] as const) {
    const model = await resolveHostModelFrom(
      sources({ credentials: [cred({ provider: ours, data: { apiKey: "k" } })] }),
    );
    assert.equal(model?.provider, theirs, `${ours} should map to ${theirs}`);
  }
});

test("the credential the user chose wins over an older one", async () => {
  const model = await resolveHostModelFrom(
    sources({
      settings: { [HOST_MODEL_SETTING]: "c2" },
      credentials: [
        cred({ id: "c1", provider: "openai", name: "first" }),
        cred({ id: "c2", provider: "anthropic-key", name: "chosen", data: { apiKey: "k2" } }),
      ],
    }),
  );
  assert.equal(model?.credentialName, "chosen");
  assert.equal(model?.provider, "anthropic");
});

test("a chosen credential that no longer works falls through", async () => {
  // The intent was "use a model". Failing outright would serve it worse than
  // quietly using the one that still has a key.
  const model = await resolveHostModelFrom(
    sources({
      settings: { [HOST_MODEL_SETTING]: "gone" },
      credentials: [cred({ id: "c1", name: "still here" })],
    }),
  );
  assert.equal(model?.credentialName, "still here");
});

test("a credential with no key is skipped, not used", async () => {
  const model = await resolveHostModelFrom(
    sources({
      credentials: [
        cred({ id: "c1", provider: "openai", data: {}, name: "empty" }),
        cred({ id: "c2", provider: "xai-llm", data: { apiKey: "k" }, name: "real" }),
      ],
    }),
  );
  assert.equal(model?.credentialName, "real");
});

test("a provider we cannot drive is never selected", async () => {
  // `claude` holds an OAuth token for the CLI, not an API key this SDK can
  // send — so a project with only that is still unconfigured.
  const model = await resolveHostModelFrom(
    sources({ credentials: [cred({ provider: "claude", data: { token: "oauth" } })] }),
  );
  assert.equal(model, null);
});

test("a token-shaped credential is read too", async () => {
  // Some rows store `token` rather than `apiKey`; sandbox env fan-out already
  // accepts both.
  const model = await resolveHostModelFrom(
    sources({ credentials: [cred({ provider: "openai", data: { token: "sk-t" } })] }),
  );
  assert.equal(model?.apiKey, "sk-t");
});

test("the legacy setting still works when nothing else is saved", async () => {
  // Every install that exists today is configured this way; breaking them to
  // introduce a choice would be a poor trade.
  const model = await resolveHostModelFrom(
    sources({ settings: { openai_api_key: "sk-legacy" } }),
  );
  assert.equal(model?.provider, "openai");
  assert.equal(model?.apiKey, "sk-legacy");
  assert.match(model!.credentialName, /Settings/);
});

test("a saved credential beats the legacy setting", async () => {
  const model = await resolveHostModelFrom(
    sources({
      settings: { openai_api_key: "sk-legacy" },
      credentials: [cred({ provider: "anthropic-key", data: { apiKey: "k" }, name: "new" })],
    }),
  );
  assert.equal(model?.credentialName, "new");
});

test("an explicit model name overrides the provider's default", async () => {
  const model = await resolveHostModelFrom(
    sources({
      settings: { [HOST_MODEL_NAME_SETTING]: "claude-opus-4-20250514" },
      credentials: [cred({ provider: "anthropic-key", data: { apiKey: "k" } })],
    }),
  );
  assert.equal(model?.modelName, "claude-opus-4-20250514");
});

test("every mapped provider has a default model", async () => {
  // A provider with no default would silently fall back to an OpenAI model
  // name and fail at the API with a confusing error.
  for (const ours of Object.keys(HOST_MODEL_PROVIDERS)) {
    const model = await resolveHostModelFrom(
      sources({ credentials: [cred({ provider: ours, data: { apiKey: "k" } })] }),
    );
    assert.ok(model, `${ours} resolved to nothing`);
    if (model!.provider !== "openai") {
      assert.notEqual(
        model!.modelName,
        "gpt-5.4",
        `${ours} fell back to an OpenAI model name`,
      );
    }
  }
});
