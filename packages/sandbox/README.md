# @nexux/sandbox

Terraform-driven provisioning of **ephemeral compute sandboxes** for a project
(P0 provider: [Civo](https://www.civo.com)). Complements `@nexux/harness`
(local Docker sandboxes) with a real remote instance that clones the project's
repositories and installs its tooling.

## What it does

Given a `SandboxSpec` (instance size/region, repos + build commands, env vars,
tooling flags) it:

1. Materializes a Terraform working directory: `main.tf` (Civo instance +
   firewall + optional SSH key), `terraform.tfvars.json`, `cloud-init.sh`.
2. Runs `terraform init` / `apply -auto-approve` (or `destroy`) via the local
   `terraform` binary, streaming logs to a caller-provided sink.
3. Returns the instance id and public IP from `terraform output -json`.

The cloud-init bootstrap (logged to `/var/log/nexus-bootstrap.log` on the
instance):

- installs git/curl, and optionally Docker, Node.js 22, Claude Code
  (`@anthropic-ai/claude-code`) and Vercel's `agent-browser`
- writes project-wide env vars to `/etc/profile.d/nexus-env.sh`
- if a project-wide `GITHUB_TOKEN` env var is present, configures a git
  `insteadOf` rewrite so private `https://github.com/...` clones authenticate
  with it (`x-access-token`)
- clones each repository into `/opt/nexus/<name>`, writes repo-scoped `.env`
  files, and runs the configured install/build commands
- touches `/opt/nexus/.bootstrap-complete` when done

## Security notes

- The Civo API token is passed to the terraform process via the `CIVO_TOKEN`
  env var only — it is never written into the working directory.
- `cloud-init.sh` and `terraform.tfvars.json` can contain project env var
  values, so the workDir is created `0700` and files `0600`.
- The workDir (including `terraform.tfstate`) must be kept until the sandbox
  is destroyed — it is the only record of what to tear down.

## Requirements

- `terraform` >= 1.5 on PATH (override with `NEXUX_TERRAFORM_BIN`).
- A Civo API token (Settings key `civo_api_key`, or `CIVO_TOKEN` env var).
