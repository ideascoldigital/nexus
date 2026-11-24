<p align="center">
  <img src="docs/assets/nexus-logo.svg" width="96" alt="Nexus logo" />
</p>

<h1 align="center">Nexus</h1>

<p align="center">
  <strong>Local-first AI dev orchestrator.</strong><br/>
  Define projects, queue features on a board, and let coding agents implement them on
  disposable sandboxes — cloud or Docker — with PRs, live previews and Telegram/Slack
  control. Or hand everyday work to bots: AI teammates with a job and a computer of
  their own. No cloud account required to start.
</p>

---

## Install

**macOS (Apple Silicon)** — with Homebrew:

```bash
brew tap ideascoldigital/tap
brew trust ideascoldigital/tap
brew install --cask ideascoldigital/tap/nexus
```

Keep `--cask` and the full name: `brew install nexus` installs an unrelated
formula from homebrew/core.

**Windows and Linux** (and macOS without Homebrew) — download the latest build
from [Releases](https://github.com/ideascoldigital/nexus/releases/latest):
`Nexus_<version>_x64-setup.exe` or `.msi` for Windows, `.AppImage`, `.deb` or
`.rpm` for Linux, `Nexus_<version>_aarch64.dmg` for macOS. The macOS bundle is
ad-hoc signed and not notarized; the cask clears the quarantine flag for you,
and after a manual install `xattr -dr com.apple.quarantine /Applications/Nexus.app`
does the same.

**Updates install themselves.** A release build checks GitHub a minute after
launch and every six hours, downloads and installs a newer release in the
background, and shows *Nexus vX is installed — Restart*; nothing restarts until
you click it, so a bot is never cut off mid-task. On Windows the installer takes
over and reopens the app; on Linux this covers the AppImage (a `.deb` or `.rpm`
install updates by installing the new package). To turn it off, give the app `NEXUX_AUTO_UPDATE=0` — an app
opened from the Finder does not see your shell's variables, so on macOS use
`launchctl setenv NEXUX_AUTO_UPDATE 0` and reopen it. `brew upgrade --cask nexus`
works too.

**A 24/7 server** — run the image `ghcr.io/ideascoldigital/nexus` on a VM; see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Or build from source: [Quick start](#quick-start).

## What it does

**Bots — AI teammates with a computer of their own**

- **A team, each with a job** — a simple `/bots` view, away from the dashboard: ask a bot for something in a chat and it works on **its own Linux desktop with Chromium**, a Docker container (local or on a remote Docker endpoint) that you watch live — in a dialog, beside the chat, or under its details — and can take over to type a password yourself.
- **Teamwork** — bots hand parts of a task to the teammate whose job it is, share a workspace folder you see on your Mac, and share browser sign-ins (except Google, which refuses shared sessions).
- **Routines** — a bot takes on recurring work on a cron schedule in your time zone, created from the chat.
- **In the chat** — attachments (paperclip, drag and drop, paste a screenshot), choice buttons when it needs a decision, email cards you edit and send, images and files it hands back.
- **Vault** — passwords, API keys and notes **sealed at rest** (AES-256-GCM, the key in the macOS Keychain or a `vault.key` file on Linux hosts); bots fill a login form from the vault without ever reading the secret, and only the bots you choose may use each entry.
- **Connect Apps** — apps connected once, used by every bot you allow: **Gmail** and **Google Calendar** built in (through your own Google OAuth app — bots search, draft and send mail, read the agenda, find free time and schedule; tokens never leave Nexus), plus Slack, Notion, Airtable, MongoDB, PostgreSQL, Supabase, HubSpot, Brave Search, GitHub and Stripe as MCP servers.

**Projects & planning**

- **Workspaces** — hard isolation boundaries: each workspace owns its projects, agent/skill catalogs, credentials and settings (new workspaces inherit the default's tokens until they define their own). Switch from the sidebar or ⌘K.
- **Definition documents** — a multi-role agent panel (PM, architect, finance, UX, detractor) builds a phased planning document from a chat.
- **Feature kanban** with a **Queue column**: drop a card there and it's dispatched, in order, to the project's dev sandbox; the card moves to In Progress while running and In Review when done. An index-aware assistant helps draft features citing real files.
- **Stack canvas** — repos + infra services (postgres, redis, mongo…) as nodes; generates docker-compose for local runs and provisions the same services into every sandbox.
- **Semantic search** — LanceDB + Ollama embeddings over repos and project docs; powers ⌘K, the feature assistant and the context injected into remote agents.
- **Plan before you build** — fire a read-only Claude plan-mode run against the real checkouts; the plan lands on the feature as a reviewable draft (approve/reject) and travels into the implementing run's prompt.
- **Workspace pulse** — stat tiles on home and /projects: 7-day spend with a 14-day sparkline, run success rate, PRs opened by runs, cloud-vs-local machines, and the review queue.

**Sandboxes & agent runs**

- **Providers**: Civo, AWS EC2 (Terraform) or a **local Docker container** (free, same bootstrap, DinD for stack services). Setup is a step wizard: type → machine → code (auto-detected commands & env keys) → tooling → agent → launch.
- **Task pipeline**: branch → Claude Code implements/tests/commits → push → **pull request** with product screenshots and an optional **Cloudflare live-preview URL**. Per-project Claude model (Sonnet/Opus/Haiku).
- **Agent brains**: Claude Code by default, **OpenCode** as a second delegable brain (75+ providers via saved LLM credentials).
- **Dev sandboxes**: mark any sandbox as dedicated and drive it from a chat-style **dev console** — serial prompt queue, continuous session with manual reset, no PR ceremony (you decide when to commit), live log tail, screenshot delivery.
- **Lifecycle**: ephemeral sandboxes that self-destroy after their task, cron/one-shot **scheduled tasks** (launch → run → PR → destroy), pause/resume for Docker sandboxes, crash-safe recovery on boot, auto-destroy of a feature's sandboxes when it reaches Done.

**Import from the trackers you already use**

- **GitHub** — issues become features (review tree, per-issue checkboxes, provenance links), and **Projects V2 boards** map into the roadmap: iterations → phases, status columns → kanban status, with a **Sync board** button that follows upstream moves.
- **GitLab** — first-class support for **self-hosted instances** (a server is a URL + a token you usually already saved for cloning). Import by project, group (subgroups included) or **epic** — an epic becomes a dev phase with its description as the goal. Or just **paste any GitLab URL** — board, epic, milestone view, project — and import what it names; **board imports keep the column each issue sat in**.
- **ClickUp** — OAuth app, then workspace → space → list sync with the same review-tree flow.
- Every import links provenance (issue ↔ feature), and PR/MR chips on cards and feature sheets carry the delivery back to where the work is tracked.

**Notifications & remote control (Telegram + Slack)**

- **Telegram**: task/sandbox notifications (with **screenshots as photos**), reply-to-continue follow-ups, per-project group chats with one-click group creation/linking, dev-console prompts from your phone, per-sandbox mute.
- **Slack**: the same notifications rendered as mrkdwn with screenshot uploads, per-project channels picked **by name** (with inline channel creation), and **thread replies act as follow-ups** via Socket Mode — an outbound WebSocket, so it stays local-first with no public URL.
- One notification hub fans out to both mediums; a lost notification never fails the run that produced it, and a sandbox's mute flag silences both.

**Catalogs & AI recommendations**

- Browse and install **skills from [skills.sh](https://skills.sh)** and **agents from [aitmpl.com](https://aitmpl.com)** (420+), straight into `~/.claude` and the workspace catalog.
- **Recommend skills/agents** in Orchestrate: the LLM profiles the project (definition, package.json dependencies, stack) and ranks the best fits with evidence-citing reasons — one-click attach or "Apply all".

**Automation & APIs**

- **MCP control surface** — `/api/mcp` (streamable HTTP) lets a local Claude or any MCP client list projects, inspect activity, send tasks and launch/power sandboxes, gated by `nxs_…` API tokens with **blast-radius scopes** (`sandboxes:write` — real money — is separable from `tasks:write`).
- **Config export/import** — move an install between machines as one JSON file: configuration by default, secrets only opt-in and **sealed with a passphrase** (scrypt + AES-256-GCM), machine state never. Imports converge (upsert by id) with a dry-run preview, and `?template=true` produces a structure-only file to hand a teammate.
- **In-app terminals** — WebSocket ptys into the host and every sandbox, with per-pane shell picking (PowerShell, cmd, or any WSL distro on Windows).

**Desktop & 24/7 deployment**

- **Native app** — Tauri v2 shell for macOS, Windows and Linux bundling the dashboard as a Node sidecar, with a version statusbar and **automatic updates**: new releases download and install in the background, then wait for you to restart (see [Install](#install)).
- **Nexus hosts** — run the server image (`ghcr.io/ideascoldigital/nexus`) on a VM via docker-compose, ideally bound to a **Tailscale address** (the dashboard has no auth — see [SECURITY.md](SECURITY.md)); hosts report their build, self-update from the UI, and reclaim their own disk. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Repo layout

| Path | What |
|---|---|
| `apps/web` | Next.js 16 dashboard (App Router, Tailwind, Base UI) — all product surfaces |
| `apps/native` | Tauri v2 desktop shell bundling the dashboard as a Node sidecar |
| `packages/db` | Prisma 7 + SQLite (better-sqlite3) — local database |
| `packages/sandbox` | Sandbox provisioning (Terraform templates, cloud-init bootstrap, Docker/SSH exec, Claude/OpenCode runners) and bots' computers |
| `packages/harness` | Local docker-compose generation & stack runner |
| `packages/embeddings` | LanceDB + Ollama (nomic-embed-text) semantic index |
| `packages/terminal` | node-pty WebSocket terminal server |
| `packages/core` / `packages/config` / `packages/llm` / `packages/storage` | Shared enums, config, LLM providers, fs storage |

## Quick start

```bash
pnpm install
pnpm db:migrate
pnpm dev          # dashboard on http://localhost:3333
```

Desktop: `pnpm dev:native` (dev) · `pnpm build:native` (bundle into
`apps/native/src-tauri/target/release/bundle/`).

**Requires** Node 20–24 (an LTS line; Node 25's experimental `localStorage`
breaks `next build`'s prerender), pnpm ≥ 10, and a Rust toolchain for the
desktop app. The bundle ships the `node` that built it, so build with the Node
you want the app to run on. A bundle built from a checkout **does not update
itself** — only release builds from CI do; otherwise it would replace your build
with an older published release.

| Optional dependency | Enables |
|---|---|
| Docker | Local sandboxes, stack runner, DinD services, bots' computers |
| Ollama (`nomic-embed-text`) | Semantic search & agent context |
| Terraform | Civo/AWS cloud sandboxes |
| Claude Code token (`claude setup-token`) | Agent runs on sandboxes |
| GitHub/GitLab/Bitbucket token | Private clones, pull requests & issue/board imports |
| Telegram bot token | Notifications & remote control |
| Slack bot (+ app) token | Notifications & thread-reply follow-ups |
| ClickUp OAuth app | Task imports |
| Google OAuth app (Desktop client, Gmail + Calendar APIs) | Gmail and Google Calendar for bots |
| OpenAI API key | Assistants (stack, features, recommendations) |

Tokens and provider credentials are managed in **Settings** (stored locally in SQLite, masked in the UI, never committed); each project picks its credentials in the sandbox wizard.

## Releasing

Push a tag: `git tag v0.3.6 && git push origin v0.3.6`. `release-native.yml`
syncs every manifest's version from the tag, builds macOS (arm64), Linux and
Windows, and attaches the bundles to a **draft** release; `release-image.yml`
publishes the server image. **Publishing the draft is the release**: installed
apps pick it up on their next check, and `bump-homebrew.yml` points the
[Homebrew cask](https://github.com/ideascoldigital/homebrew-tap) at it.
Prereleases are skipped by both.

The auto-update and the cask download releases anonymously, so they need the
repository to be public. To try a build without releasing, run **Release native
app** by hand from the Actions tab: it uploads the bundles as workflow artifacts
(14 days) and publishes nothing.

The full walkthrough, with a pipeline diagram, is in [docs/RELEASING.md](docs/RELEASING.md).

## Docs

- [AGENTS.md](AGENTS.md) — agent guide (rules, commands, conventions)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture map (+ per-module `ARCHITECTURE.md`)
- [docs/PROGRESS.md](docs/PROGRESS.md) — state & timeline
- [docs/DECISIONS.md](docs/DECISIONS.md) — decision log
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — running it on a 24/7 host (read the security notes first)
- [docs/RELEASING.md](docs/RELEASING.md) — cutting a release (tag → draft → publish → Homebrew, with a diagram)
- `specs/` — design specs (sandbox provisioning, embeddings, harness, OpenCode brain, bots, vault, connectors, …)

## Security

The dashboard has **no authentication** — it is designed to run on
`localhost` or a private tailnet, never on a public interface. See
[SECURITY.md](SECURITY.md) before deploying anywhere, and report
vulnerabilities privately through GitHub security advisories.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
conventions and the PR checklist.

## License

[MIT](LICENSE) © Ideascol
