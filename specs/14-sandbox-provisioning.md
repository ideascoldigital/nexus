# 14 — Project Setup & Sandbox Provisioning (Terraform + Civo)

## Goal

A per-project **Setup** section that captures everything needed to reproduce
the project on a fresh machine — repositories, install/build/run commands,
environment variables, tooling — and a one-click way to spin up an
**ephemeral compute sandbox** from that config. Terraform provisions a real
Civo instance; cloud-init clones the repos and installs the tooling.

This complements `13-harness.md` (local Docker sandboxes): the harness is for
fast, locked-down local execution; this is for a full remote dev/test box.

## Data model (`packages/db/prisma/schema.prisma`)

- `SandboxConfig` (1:1 Project) — region, size, disk image, optional SSH
  public key, tooling flags (`installDocker`, `installNode`,
  `installClaudeCode`, `installAgentBrowser`), optional extra `setupScript`.
- `RepositorySetup` (1:1 Repository) — `installCommand`, `buildCommand`,
  `runCommand`.
- `ProjectEnvVar` — `repositoryId == null` → project-wide (exported via
  `/etc/profile.d/nexus-env.sh`); set → written to that repo's `.env` after
  clone.
- `Sandbox` — one provisioning run: status machine
  `pending → provisioning → running → destroying → destroyed` (or `error`),
  instance id, public IP, terraform `workDir`, streamed `log`.

Migration: `20260711120000_sandbox_setup` (applies automatically at startup
via `ensureMigrated` when `NEXUX_MIGRATIONS_DIR` is set).

## Packages & files

- **`packages/sandbox` (`@nexux/sandbox`)** — provider layer.
  - `template.ts` renders `main.tf` (civo provider ~> 1.1: instance +
    firewall with SSH-only ingress + optional SSH key + disk-image data
    source), `terraform.tfvars.json`, and the `cloud-init.sh` bootstrap.
    Templates are embedded strings so Next.js bundling can't lose assets.
  - `terraform.ts` spawns the local `terraform` binary
    (`NEXUX_TERRAFORM_BIN` override) with `TF_IN_AUTOMATION`/`TF_INPUT=0`.
  - `provisioner.ts` — `applySandbox` (init + apply + `output -json`),
    `destroySandbox`, `prepareWorkDir` (0700 dir / 0600 files).
- **`apps/web/src/lib/sandbox-manager.ts`** — DB wiring: builds the
  `SandboxSpec` from project data, creates the `Sandbox` row, runs
  apply/destroy asynchronously, throttles terraform output into
  `Sandbox.log` (1 flush/s), guards concurrent ops per sandbox.
- **API routes** (`apps/web/src/app/api/projects/[projectId]/…`):
  - `setup` — GET (config + repo setups + masked env vars + readiness),
    PUT (upsert config + repo setups).
  - `env-vars`, `env-vars/[envVarId]` — POST upsert, PUT value, DELETE.
    Values are masked in every response (`••••` + last 4).
  - `sandboxes` — GET list (without log), POST launch (202).
  - `sandboxes/[sandboxId]` — GET detail (with log), DELETE destroy (202).
- **UI** — `components/projects/project-sandboxes.tsx`, mounted as the
  `sandboxes` tab on the project detail page. The sandbox list (live status,
  expandable terraform log, terminal/password/destroy actions) is the main
  view; a "New sandbox" button opens a right-side drawer (Sheet) with the
  full setup form — instance config, per-repo commands, env vars — and
  "Launch sandbox" / "Save only" actions. A readiness banner (terraform CLI
  + Civo token) sits above the list.
- **Root password reveal** — each running sandbox row has a key button that
  fetches the Civo-generated root password on demand (`GET
  .../sandboxes/[id]/password`): read from local terraform state
  (`write_password = true` on the instance resource) with a Civo API
  fallback for older sandboxes. Never persisted in the DB or included in
  regular sandbox payloads.
- **In-app SSH terminal** — a running sandbox row has a "Terminal" button
  that jumps to the Terminal tab with an SSH session to the instance, and
  running sandboxes appear in the terminal picker (cloud icon) as split/new
  targets. Mechanism: a terminal `cwd` of `ssh://user@host` makes the local
  node-pty server spawn `ssh -o StrictHostKeyChecking=accept-new user@host`
  instead of a shell (strictly validated so the target can't inject ssh
  flags). Authentication is automatic: Nexux keeps a per-install keypair at
  `<dataDir>/ssh/id_ed25519` (generated with ssh-keygen on first launch); the
  public key is registered on every sandbox via terraform and the terminal
  server passes `-i` with the private key, so no password is ever prompted.
  A user-provided SSH public key (Setup drawer) is additionally appended to
  `/root/.ssh/authorized_keys` by the bootstrap.
- **Destroy & remove** — destroying a live sandbox requires a confirmation
  dialog (`terraform destroy` is irreversible); DELETE on an
  already-destroyed sandbox just removes its DB record from the list.

## Provisioning flow

1. `POST /sandboxes` validates: terraform on PATH, Civo token present, at
   least one repo with a clone URL.
2. workDir = `<dataDir>/sandboxes/<sandboxId>` gets `main.tf`,
   `terraform.tfvars.json`, `cloud-init.sh`.
3. `terraform init` + `apply -auto-approve` run with `CIVO_TOKEN` in the
   process env only; output streams into `Sandbox.log`.
4. Outputs (`instance_id`, `public_ip`) land on the row; status → `running`.
   Cloud-init keeps working on the instance (log:
   `/var/log/nexus-bootstrap.log`, marker `/opt/nexus/.bootstrap-complete`).
5. `DELETE /sandboxes/[id]` runs `terraform destroy` from the same workDir;
   status → `destroyed`.

Bootstrap (cloud-init) order: apt basics → project env vars → Node 22
(NodeSource) → Docker (get.docker.com) → `@anthropic-ai/claude-code` →
`agent-browser` → git auth (if a project-wide `GITHUB_TOKEN` env var exists,
an `insteadOf` rewrite authenticates `https://github.com/` clones with it) →
clone repos into `/opt/nexus/<slug>` (+ repo `.env`, install/build commands
with project env loaded) → custom `setupScript`. Every step is non-fatal
(`|| WARN`) so one failure doesn't brick the box.

## Credentials & security

- Civo token: Settings row `civo_api_key` (provider `civo`) or the
  `CIVO_TOKEN` env var. It is **never written to disk** — passed only via
  the terraform process env.
- Env var values live in the local SQLite DB and are embedded in
  `cloud-init.sh` inside the 0700 workDir; API responses always mask them.
- The workDir (esp. `terraform.tfstate`) must be kept until destroy — it is
  the only record of what to tear down. Destroyed sandboxes keep their
  workDir for audit; clean up manually if desired.
- Firewall allows inbound SSH (22) only.

## Known gaps / future work

- Private repos: covered for github.com via the `GITHUB_TOKEN` project env
  var; other hosts (GitLab, Bitbucket) still need a token embedded in the
  URL or a future deploy-key story. The token lands in the instance's root
  git config — acceptable for an ephemeral sandbox, but use a fine-grained
  PAT scoped to the needed repos.
- No TTL/auto-destroy yet — sandboxes bill until destroyed.
- Server restart mid-provision leaves status `provisioning`; destroy still
  works because tfstate is on disk. A reconciler could detect stale rows.
- `runCommand` is stored and shown but not auto-executed (no service
  supervision yet).
- Optional auto-launch on project creation, once a project has setup config.
- Additional providers (AWS/Hetzner/local Docker) can slot in behind
  `SandboxSpec` + a second template module; `Sandbox.provider` already
  exists.
