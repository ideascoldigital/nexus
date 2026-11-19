# @nexux/sandbox — Architecture

> Full sandbox lifecycle: provisions cloud VMs (Civo/AWS via Terraform) or a local docker-in-docker container, bootstraps them with cloud-init, and runs Claude Code tasks over SSH / `docker exec`. Spec: `specs/14-sandbox-provisioning.md`.

## Purpose

Reproduce a project on a fresh machine — repos, tooling, env — and run agentic tasks on it. Complements `@nexux/harness` (fast local locked-down exec); this is the full remote dev/test box.

The package provisions **two kinds of machine** from the same Terraform module. A *sandbox* clones repos, installs agent CLIs and runs tasks (`template.ts`). A *Nexus host* (spec 19) installs Docker + Tailscale and runs Nexux itself 24/7 (`template-host.ts`) — it is not a sandbox, has no project, and is never ephemeral, which is why it gets its own `NexusHost` row rather than sharing `Sandbox`.

## Key files

| File | Role |
|---|---|
| `src/types.ts` | `SandboxSpec`, `SandboxRepoSpec`, `SandboxProvider` (`civo` / `aws` / `local`), `SandboxBrain` (`claude` / `opencode`), provision outputs |
| `src/template.ts` | The heart: `renderMainTf` (embedded Civo & AWS Terraform), `renderCloudInit` (bootstrap: agent user, SSH keys, Node/Docker/Claude Code/cloudflared/Tailscale (optional tailnet join — `--login-server` for a self-hosted control plane, `--accept-routes`, keyless registration via the shared `renderTailscaleLogin`)/gh install, stack compose, repo clone/mount + install inference), `renderTfVars`, `AGENT_USER`, `safeSlug`; `renderRepoSetup` (clone+install+build, shared with the UI's Retry setup — adopts an existing checkout) |
| `src/bootstrap-report.ts` | Spec 24 piece 1: `renderStepHelpers` (the `nexus_step` / `nexus_step_run` bash) + `parseBootstrapReport` / `failedSteps`. One JSON line per step into `/opt/nexus/bootstrap-report.jsonl` — what replaced scraping WARNs out of the log |
| `src/base-image.ts` | Spec 24 piece 3: `renderBaseDockerfile` (the tooling half of the bootstrap, baked once) + `dryRunSpec` (drops agent CLIs, Chromium, tunnel, tailnet). Version pinned by an image **label**, not the tag |
| `src/boot-probe.ts` | Spec 24 piece 2: `renderBootProbe` / `renderBootProbeHelper` — start the app, wait for its port, kill the process group, record `boot:<repo>`. Plus `renderStepTailHelper`, which attaches a JSON-escaped log tail to a failure |
| `src/terraform.ts` | `runTerraform` / `terraformAvailable` — creds passed via env, never written to disk |
| `src/provisioner.ts` | `applySandbox` / `destroySandbox` / `readOutputs` / `readInitialPassword` / `prepareWorkDir` (writes tf module + cloud-init; enforces EC2 16KB user_data limit) |
| `src/local.ts` | Local fallback: privileged Ubuntu container + DinD volume, same cloud-init in "container" mode; URL-less repos bind-mount their local folder at `/opt/nexus/<slug>` |
| `src/remote.ts` | `execRemote` (SSH or `docker exec` via `bash -lc`), `fetchRemoteDir`, `pushLocalDir`, `runClaudeTask` — runs `claude -p … --permission-mode bypassPermissions --output-format stream-json` **on the sandbox**, parses events into progress + `ClaudeRunResult` |
| `src/runner.ts` | Brain dispatch: `runAgentTask(brain, prompt, opts)` routes to `runOpenCodeTask` or `runClaudeTask`, plus the OpenCode command builder / stream parser. Both brains normalize to `AgentRunResult` |
| `src/env.ts` | Credential fan-out: `GLOBAL_ENV_SETTINGS` allowlist (Settings key → env var), `LLM_CREDENTIAL_ENV` (`CloudCredential.provider` → env var), `applyGlobalSecrets` / `applyLlmCredentials` (merge in place, existing values win) |
| `src/keys.ts` | `ensureSandboxKeypair` — one ed25519 key per install under `<dataDir>/ssh` |
| `src/ssh-config.ts` | Managed `~/.ssh/config` Include block for VS Code Remote-SSH; `vsCodeRemoteUri` |
| `src/workspace.ts` | `renderCodeWorkspace` / `writeCodeWorkspaceCommand` — the multi-root `.code-workspace` at `/opt/nexus/nexus.code-workspace`, one first-level folder per repo |
| `src/slug.ts` | `safeSlug` (re-exported by `template.ts`) + `shq` (single-quote escaping for generated bash); own module so template ↔ workspace don't cycle, and so both bootstraps share one escaping implementation. Also the machine-naming rules: `sandboxInstanceName(project, id, prefix)` builds `<prefix><project>-<id>` (prefix defaults to `nexux-`, overridden by the `sandbox_name_prefix` setting), `normalizeSandboxPrefix` validates that setting, and `customSandboxName` takes a typed name as the **whole** hostname — a chosen name replaces the prefix instead of extending it |
| `src/template-host.ts` | **Nexus host** bootstrap (spec 19): `renderHostCloudInit` / `renderHostCompose` / `parseHostMarker`, plus `safeHostName` and `isValidImageRef`. Shares `renderMainTf` with sandboxes — provisioning a VM is the same problem; what the VM *becomes* is what differs. `renderHostCompose({ mode: "endpoint" })` is the spec 27 stack for a host on a Docker endpoint: Tailscale as a userspace sidecar, Nexux in its network namespace, no `ports:` at all, no control-dir mount; the Nexux `environment` block is shared with the VM mode so the two cannot drift |
| `src/docker-endpoint.ts` | **Remote Docker endpoints** (spec 26): `parseDockerHost` (ssh:// only, strict charset — the value ends up in argv), `dockerHostArgs` (`["-H", host]` or `[]`; the one way a docker argv gets pointed elsewhere), `probeDockerEndpoint` (one `docker info` over SSH, spawned detached so ssh can never sit on a password prompt; refuses rootless daemons because sandboxes need `--privileged`) and `explainProbeFailure`. Threaded through `local.ts` (every exported function takes an optional `target`, and a private `docker()` helper is the only way it spawns docker) and the container transport in `remote.ts` (`dockerHost` on `RemoteExecOpts`, `fetchRemoteDir`, `pushLocalDir`, `SandboxAddress`). `launchLocalSandbox` refuses bind mounts on a remote daemon — the path would resolve on the wrong disk |
| `src/bot.ts` | **Bots** (spec 31): the `nexux-bot` image (Debian + Xvfb/fluxbox + noVNC + Chromium + Claude Code + Playwright MCP), rendered as a stdin Dockerfile tagged by its own hash; `launchBotContainer` (`--rm`, loopback noVNC, token via env name), `botReadiness`, `stopBotContainer`, `listBotContainers`, `renderBotSystemPrompt`, `runBotPrompt` (`claude -p` in the container, Playwright MCP attached to the visible Chromium over CDP) |
| `src/nexus-cli.ts` | The in-sandbox `nexus` command: `buildNexusManifest` / `manifestFromSpec` (the on-box process manifest) and `renderNexusCliSection` (bash that writes `/opt/nexus/nexus.json` + `/etc/profile.d/nexus-cli.sh`) |

## Dual brain

A sandbox runs delegated tasks through one of two agent CLIs (`SandboxBrain = "claude" | "opencode"`). Callers stay brain-agnostic by going through `runAgentTask`, which dispatches on the brain and returns the same `AgentRunResult` shape either way; `runClaudeTask` / `runOpenCodeTask` remain exported for direct use. Provider API keys reach whichever brain is selected via `src/env.ts`.

## VS Code workspace

A sandbox holds N repos side by side under `/opt/nexus`. VS Code opens one folder per window, so pointing the deep link at `/opt/nexus` would bury every repo one level down. Bootstrap therefore writes `/opt/nexus/nexus.code-workspace` — a multi-root workspace with one first-level folder per repo, paths relative so the same file works over Remote-SSH and Dev Containers. The `vscode` API route regenerates it from the current `Repository` rows before launching (repos added after provisioning show up), and opens the workspace file rather than the folder. An explicit `path` in the request body still wins, and a failed write falls back to plain `/opt/nexus`.

## The `nexus` CLI

Every sandbox shell gets a banner and a `nexus` command: `nexus` (banner + projects + process status), `nexus start|stop|restart <alias>` (or `all`), `nexus logs <alias> [-f]`, `nexus cd <project>`, `nexus status`, `nexus info`, `nexus help`. Aliases are slugged labels, unique by construction; the full process key works too.

It reads `/opt/nexus/nexus.json`, written at bootstrap and refreshable from the dashboard (`pushNexusCli` → POST `…/sandboxes/<id>/cli`). The bootstrap copy is spec-derived — `renderCloudInit` has no database, so it knows only each repo's `runCommand` — and the push replaces it with the canvas-resolved plans from `getSandboxProcessPlans`. `nexus info` prints the write date so a stale manifest is visible rather than silent.

Start/stop mirror `sandbox-process-manager.ts` exactly: same `/tmp/nexus-proc-<key>.{sh,pid,log}` paths, `setsid` for a fresh process group, kill by recorded PID (never `pkill -f` — the launcher's own command line would match). A process started in the terminal is therefore the same one the UI lists and stops.

Two constraints on the generated script: the banner is guarded on an interactive shell, because `execRemote` sources profile.d through `bash -lc` and the host parses that stdout for `PID:` / `PREVIEW:` markers; and parsing uses `python3`, not `jq`, which `ubuntu:22.04` does not ship. In `src/nexus-cli.ts` the script body is a `String.raw` template where `@@{` stands in for bash's `${` — `String.raw` still interpolates `${}`, so the placeholder is substituted back at the end. Backticks in that body must be quotes for the same reason.

## Step results

Every step worth reporting on — clone, install, build, `stack:up`, the docker
install, each launcher — runs through `nexus_step_run` and appends a line to
`/opt/nexus/bootstrap-report.jsonl`. The two markers are unchanged
(`.bootstrap-complete` / `.bootstrap-failed`): the report is a third file, not
a new contract for the pollers that already depend on them.

Severity is passed per call site, not derived from the exit code — a failed
main clone and a failed tailscale install both exit non-zero and only one of
them means the box is useless. `renderRepoSetup` re-emits the helpers because
the retry action runs that block on its own, where the preamble is not in
scope. See D-71.

## Does it boot?

Each repo with a run command *and* a port is probed at the end of the
bootstrap: started, waited for, then stopped. A repo without a port is not
probed — a process surviving three seconds is not evidence the app works.

The kill targets the process group (`set -m`, not `setsid` — absent on macOS,
where the helpers are tested), because a package manager spawns the real
server as a child and killing the recorded PID alone leaves the port held.
See D-72.

## Fast dry runs

`local.ts` starts from `nexux/sandbox-base:v<N>` when one is built and current,
falling back to `ubuntu:22.04` otherwise — it **never builds inline**, since a
launch that quietly spent minutes building is the surprise this removes.
`buildSandboxBaseImage` is the explicit action.

Measured with a real repo (install + build + boot probe): 52s → 23s. See D-74,
including why `installDocker` is the one toggle a dry run keeps.

## Security posture

Credentials via env only (never disk), dedicated keypair (offering only the sandbox key — agent keys exhausted MaxAuthTries), injection-safe quoting throughout.

`src/env.ts` encodes the fan-out invariant: only allowlisted Settings keys may reach a sandbox. Provisioning and notification secrets — `civo_api_key`, `telegram_*` — are deliberately absent from the allowlist and must **never** leave the host. Precedence is project env vars > per-sandbox credentials > global Settings; existing values are never overwritten. Rules are pinned by `src/env.test.ts` — keep them in sync.

## Note on the Claude rule

`runClaudeTask` uses `claude -p` **inside the sandbox VM/container**, not on the host — the local-first rule (no headless Claude on the host) governs the developer machine; sandboxes are the sanctioned place for automated Claude runs launched from the UI.

## Dependencies

Internal: `@nexux/config`. External: none — shells out to `terraform`, `ssh`/`scp`, `docker`, `ssh-keygen`.

## State

Most feature-dense, production-oriented package. Multi-cloud + local fallback complete.
