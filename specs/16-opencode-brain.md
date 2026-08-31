# 16 — OpenCode as a second delegable brain in sandboxes

## Goal

Allow the user to delegate tasks (kanban Queue, dev sandbox prompts,
PR pipeline) to **Claude Code or OpenCode** (open-source agentic CLI,
`opencode.ai`, repo `anomalyco/opencode`). When creating/configuring a sandbox the
**brain** is chosen, and for OpenCode: the **model** (`provider/model`) and the
provider **API keys** to inject (multiple named credentials, same
as those of Claude Code). Global configuration in Settings → AI Providers.

Fits rule D-02 / AGENTS.md: Claude automation only happens
inside the sandbox (`runClaudeTask`); OpenCode follows the same
in-sandbox pattern and is also brain-agnostic by design (75+ providers via
models.dev), so a single binary covers OpenAI, OpenRouter, Google, xAI,
Ollama, etc.

## OpenCode context (verified facts, v1.18.x)

- Install: `npm install -g opencode-ai` (binary `opencode`) or
  `curl -fsSL https://opencode.ai/install | bash`.
- Headless one-shot: `opencode run "<prompt>" --format json -m provider/model`
  → JSON event stream on stdout (equivalent to `claude -p
  --output-format stream-json`).
- Session resume: `-s <sessionId>` (equivalent to `--resume`), `-c` last one,
  `--fork` to branch.
- Unattended permissions: `--auto` (auto-approves what would be in `ask`;
  respects `deny` rules). Alternative: `"permission": {"*": "allow"}` in
  config.
- Injectable config without touching disk: env `OPENCODE_CONFIG_CONTENT` with the
  full JSON (`model`, `permission`, `provider`, `agent`, `mcp`…).
- Auth: recognizes env vars per provider (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, xAI keys,
  Bedrock, Azure…). No `auth.json` needed if we inject env vars.
- Model: format `provider_id/model_id` (e.g. `anthropic/claude-sonnet-4-5`,
  `openai/gpt-5`, `openrouter/…`). `opencode models` lists the available ones
  (parseable for the picker).
- Instructions: reads `AGENTS.md` natively (and falls back to `CLAUDE.md`); our
  repos already have it → zero extra setup.
- Future (phase 2): `opencode serve` exposes HTTP + SSE (`GET /event`) and the
  `@opencode-ai/sdk` SDK — better for live logs, but phase 1 uses `run`
  to mirror the existing `runClaudeTask` pattern.

## Data model (`packages/db/prisma/schema.prisma`)

New migration `2026xxxx_opencode_brain`:

- `SandboxConfig` — new fields:
  - `brain String @default("claude")` — `claude | opencode`. Selector per
    sandbox-config, same pattern as `claudeModel` (`ProjectBrain` is NOT
    reused, as it is today a dead-end of the orchestration canvas; it is left
    as is).
  - `openCodeModel String?` — `provider/model` for `-m`; null = CLI
    default.
  - `installOpenCode Boolean @default(false)` — bootstrap toggle (it
    auto-enables when `brain == "opencode"`).
- `SandboxConfigLlmCredential` (new join table) — N:M between `SandboxConfig`
  and `CloudCredential`: the provider keys to inject in that sandbox
  (multiple, e.g. OpenAI + OpenRouter at the same time). Fields: `configId`,
  `credentialId`, composite unique.
- `CloudCredential.provider` — extend the domain with LLM providers:
  `openai | openrouter | google | xai-llm | anthropic-key` (in addition to the
  existing `civo|aws|github|gitlab|bitbucket|claude`). `data` = `{ apiKey }`.
  This gives "multiple named API keys" just like the Claude Code
  tokens: N credentials are created per provider and chosen per sandbox.
- `Sandbox.devSessionId` and `SandboxTask.sessionId` are reused as-is
  for the OpenCode resume (`-s <id>`); `SandboxTask` does not change (an OpenCode
  run is also "one headless agent run").

Credential → env var map (shared constant in `@nexux/sandbox`):

| credential provider | injected env var      |
|---------------------|-----------------------|
| `anthropic-key`     | `ANTHROPIC_API_KEY`   |
| `openai`            | `OPENAI_API_KEY`      |
| `openrouter`        | `OPENROUTER_API_KEY`  |
| `google`            | `GEMINI_API_KEY`      |
| `xai-llm`           | `XAI_API_KEY`         |

## Packages & files

- **`packages/sandbox`**:
  - `types.ts` — `SandboxSpec`: add `brain`, `installOpenCode`,
    `openCodeModel`, `llmEnvVars: Record<string,string>`.
  - `template.ts` (~L464, next to the `installClaudeCode` block) — `installOpenCode`
    block: `npm install -g opencode-ai` (reuses the already installed Node 22)
    + write `/etc/profile.d/nexux-llm-env.sh` with the keys +
    global `OPENCODE_CONFIG_CONTENT` with
    `{"$schema":"https://opencode.ai/config.json","permission":{"*":"allow"},
    "model":"<openCodeModel>"}` for root and the agent user. Non-fatal step
    (`|| WARN`) like the rest.
  - `remote.ts` — new `runOpenCodeTask(prompt, opts)` mirroring
    `runClaudeTask` (L245): builds
    `opencode run {-s <sid>} {-m <model>} --format json --auto "<prompt>"`
    via `execRemote`, parses the JSON stream into log lines
    (`describeOpenCodeEvent`), returns the same
    `{ ok, result, costUsd, durationMs, sessionId, error }` shape.
  - `runner.ts` (new) — **brain dispatcher**:
    `runAgentTask(brain, prompt, opts)` → `runClaudeTask` |
    `runOpenCodeTask`. Common `AgentRunResult` interface. It is the only API
    consumed by the drivers above; export from `index.ts`.
- **`apps/web/src/lib/sandbox-manager.ts`** — `buildSpec()` (L256–354):
  resolve the selected LLM credentials → `llmEnvVars`; extend
  `GLOBAL_ENV_SETTINGS` as a global fallback (`openrouter_api_key`,
  `google_api_key`, `xai_api_key` in addition to the two current ones); pass
  `brain`/`openCodeModel`/`installOpenCode` to the spec. Per-sandbox
  credentials win over the global Settings (same criterion as project env
  vars).
- **`apps/web/src/lib/task-manager.ts`** (L1034) and
  **`apps/web/src/lib/dev-console.ts`** (L208) — replace the direct call
  to `runClaudeTask` with `runAgentTask(policy.brain, …)`, with
  `model: brain === "opencode" ? cfg.openCodeModel : cfg.claudeModel`. The
  Queue → dev sandbox flow (`flushFeatureQueue`) does not change: it inherits the brain
  of the dedicated sandbox.
- **API**:
  - `api/projects/[projectId]/setup/route.ts` — GET/PUT accept and persist
    `brain`, `openCodeModel`, `installOpenCode`, `llmCredentialIds[]`.
  - `api/credentials/route.ts` — accept the new LLM `provider` values
    (validation + masked hint same as today).
- **UI**:
  - `components/projects/project-sandboxes.tsx` — in the drawer's "Agent
    policy" section: **Brain** selector (radio/select `Claude Code |
    OpenCode`). If OpenCode: **Model** input/combobox (curated list
    `OPENCODE_MODELS` — anthropic/claude-sonnet-4-5, openai/gpt-5,
    openrouter/auto, google/gemini-2.5-pro, etc. — with a free-text option
    `provider/model`) + **LLM credentials multi-select** (analogous to the
    `claudeCredentialId` picker at L~539). If Claude: the current one is shown
    (`CLAUDE_MODELS`, `claudeCredentialId`). `installOpenCode` is checked on its own.
  - `components/settings/cloud-credentials.tsx` — add the LLM providers to
    `CREDENTIAL_PROVIDERS` with labels and deep-links to the key consoles
    (platform.openai.com, openrouter.ai/keys, aistudio.google.com,
    console.x.ai, console.anthropic.com). This is where "adding multiple
    API keys" lives: N named credentials per provider.
  - `app/(dashboard)/settings/page.tsx` — the **AI Providers** tab already covers
    the global fallback keys; add the missing ones (`openrouter_api_key`,
    `google_api_key`) to the `AI_PROVIDERS` array plus a text pointing to
    Credentials for per-sandbox named keys.
  - Sandbox / feature-list rows: badge of the active brain
    (`→ {devSandbox.name} · OpenCode`) so it is visible which agent the
    Queue goes to.

## Delegation flow

1. User configures the sandbox in the drawer: brain = OpenCode, model
   `openrouter/anthropic/claude-sonnet-4-5`, credentials `[OpenRouter
   personal]`. Launch.
2. `buildSpec` resolves credentials → `llmEnvVars`; cloud-init installs
   `opencode-ai` and leaves env + `OPENCODE_CONFIG_CONTENT` at system level.
3. A dev prompt (or `flushFeatureQueue`) calls
   `runAgentTask("opencode", prompt, { model, resumeSessionId })` →
   `opencode run -s <sid> -m <model> --format json --auto` over SSH.
4. The JSON stream is translated into log lines (same run logs UI);
   the returned `sessionId` is persisted in `devSessionId`/`SandboxTask.sessionId`
   for continuity.
5. PR pipeline (`kind: "task"`) identical: the clone → agent → tests →
   PR phases do not change, only the runner of the agent step.

## Credentials & security

- The LLM keys travel the same as the current ones: local DB → `buildSpec` →
  `cloud-init.sh` in workDir 0700 → `/etc/profile.d` on the instance.
  API responses always masked (`••••` + last4).
- `--auto` respects `deny` rules; if you want to harden it, the injected
  `OPENCODE_CONFIG_CONTENT` can carry
  `"bash": {"git push *": "deny"}` when `createPr == false`.
- The at-rest encryption gap still stands: credentials are stored in
  plaintext in SQLite (config.encryptionKey exists but is not wired).
  This spec does not solve it; it inherits the risk already accepted for
  Claude/GitHub tokens.
- `ANTHROPIC_API_KEY` via the `anthropic-key` credential can collide with the
  current "skip if there is CLAUDE_CODE_OAUTH_TOKEN" logic: that rule applies only
  when `brain == "claude"`; with OpenCode it is always injected.

## Implementation plan (suggested order)

0. ✅ Safety net (done before starting): characterization tests in
   `packages/sandbox` — `remote.test.ts` (claude command, stream-json parser,
   result shape, sessionId round-trip), `env.test.ts` (global secret
   injection rules: allowlist, precedence, skip of
   ANTHROPIC_API_KEY with OAuth token) and bootstrap block in
   `template.test.ts`. To make them possible, pure seams were extracted without
   behavior change: `buildClaudeCommand` / `createStreamParser` /
   `finalizeClaudeRun` in `remote.ts`, and `applyGlobalSecrets` +
   `GLOBAL_ENV_SETTINGS` into `packages/sandbox/src/env.ts` (consumed by
   `sandbox-manager.buildSpec`). The `runAgentTask` dispatcher and
   `runOpenCodeTask` must reuse those same seams.
   Also: the pure delegation logic of `apps/web` (task/dev/feature/follow-up
   prompts, `AgentPolicy`+defaults, `sandboxTarget`/
   `sandboxReachable`, `detectNeedsInput`) now lives in
   `apps/web/src/lib/agent-core.ts` (no prisma, tested in
   `agent-core.test.ts`; `task-manager`/`dev-console` re-export). The `brain`
   field and the model selector come in through `AgentPolicy` there. CI:
   `.github/workflows/ci.yml` runs install → prisma generate → test →
   typecheck (blocking) + lint (non-blocking due to 58 pre-existing
   errors).
1. ✅ Migration + schema (`20260719170000_opencode_brain`: `brain`,
   `openCodeModel`, `installOpenCode`, join `SandboxConfigLlmCredential`,
   LLM providers in `CloudCredential`).
2. ✅ `@nexux/sandbox`: types, bootstrap block in `template.ts` (config via
   `~/.config/opencode/opencode.json`, not `OPENCODE_CONFIG_CONTENT` — it persists
   for interactive sessions just like Claude's settings.json),
   `runOpenCodeTask` + tolerant parser in `runner.ts`, `runAgentTask`
   dispatcher. Mirror tests in `runner.test.ts`.
3. ✅ `sandbox-manager.buildSpec` (`applyLlmCredentials` before the global
   fallback) + setup endpoints (replace-set of `llmCredentialIds`) and
   credentials (`{apiKey}`).
4. ✅ Drivers: `task-manager` and `dev-console` → `runAgentTask(policy.brain)`,
   `policyModel()` in `agent-core`.
5. ✅ UI: Brain selector + `OpenCodeModelPicker` (curated + free text) +
   keys multi-select in the drawer; "LLM API Keys" card in Settings → AI
   Providers; OpenCode toggle in Tooling and "Brain" summary. Verified in
   browser (API round-trip + drawer). Brain badge in feature-list: pending.
6. ⬜ e2e test on Civo: OpenCode sandbox + feature in Queue → run log → PR.
   The exact shape of the `--format json` events is validated here (the parser
   is tolerant to `properties`-nesting and `part` variants).

## Known gaps / future work

- **Phase 2 — `opencode serve` + SDK**: one server per sandbox (`--port 4096`,
  `OPENCODE_SERVER_PASSWORD`) with SSE for truly live logs and
  `prompt_async`; the dispatcher allows changing the transport without touching
  drivers.
- Remote `opencode models` to populate the picker dynamically (today a curated
  list + free text).
- Costs: OpenCode does not always report `costUsd` per event like Claude
  (`opencode stats` exists); the first version can leave `costUsd` null.
- Local providers (host Ollama/LM Studio) require a custom `provider`
  in the JSON config pointing at the host URL — easy to add to the
  `OPENCODE_CONFIG_CONTENT` by reading `ollama_url` from Settings, but the
  sandbox→host network has to be solved (tunnel/cloudflared); out of phase 1.
- `ProjectBrain` is still unconsumed; if one day the orchestration canvas
  is wired to execution, it should converge with
  `SandboxConfig.brain`.
- Version pinning of `opencode-ai` (very high release cadence); consider
  pinning a version in the bootstrap.
