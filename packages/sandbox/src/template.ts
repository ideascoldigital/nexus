import { manifestFromSpec, renderNexusCliSection } from "./nexus-cli";
import { renderBrowserInstallSection } from "./template-browser";
import { safeSlug, shq } from "./slug";
import type { SandboxProvider, SandboxRepoSpec, SandboxSpec } from "./types";
import { SANDBOX_ROOT, writeCodeWorkspaceCommand } from "./workspace";

/**
 * Written when the bootstrap finished every step it must not skip. The host
 * polls for it to call a sandbox ready.
 */
export const BOOTSTRAP_COMPLETE_MARKER = `${SANDBOX_ROOT}/.bootstrap-complete`;

/**
 * Written instead when a step the sandbox cannot work without failed, holding
 * one reason per line. Its presence suppresses the completion marker, so a
 * half-provisioned box can never read as ready.
 */
export const BOOTSTRAP_FAILED_MARKER = `${SANDBOX_ROOT}/.bootstrap-failed`;

// Renders the Terraform module + cloud-init bootstrap for one sandbox.
// Templates are embedded as strings (not shipped .tf assets) so the package
// survives Next.js bundling; files are materialized into the sandbox workDir.

export function renderMainTf(provider: SandboxProvider = "civo"): string {
  return provider === "aws" ? renderAwsMainTf() : renderCivoMainTf();
}

function renderCivoMainTf(): string {
  return `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    civo = {
      source  = "civo/civo"
      version = "~> 1.1"
    }
  }
}

# Token is read from the CIVO_TOKEN environment variable — never written to disk.
provider "civo" {
  region = var.region
}

variable "region" {
  type = string
}

variable "instance_name" {
  type = string
}

variable "size" {
  type = string
}

variable "disk_image" {
  type    = string
  default = "ubuntu-jammy"
}

variable "ssh_public_key" {
  type    = string
  default = ""
}

data "civo_disk_image" "sandbox" {
  filter {
    key    = "name"
    values = [var.disk_image]
  }
}

resource "civo_ssh_key" "sandbox" {
  count      = var.ssh_public_key == "" ? 0 : 1
  name       = "\${var.instance_name}-key"
  public_key = var.ssh_public_key
}

resource "civo_firewall" "sandbox" {
  name                 = "\${var.instance_name}-fw"
  create_default_rules = false

  ingress_rule {
    label      = "ssh"
    protocol   = "tcp"
    port_range = "22"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }

  egress_rule {
    label      = "all-tcp"
    protocol   = "tcp"
    port_range = "1-65535"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }

  egress_rule {
    label      = "all-udp"
    protocol   = "udp"
    port_range = "1-65535"
    cidr       = ["0.0.0.0/0"]
    action     = "allow"
  }
}

resource "civo_instance" "sandbox" {
  hostname    = var.instance_name
  size        = var.size
  disk_image  = data.civo_disk_image.sandbox.diskimages[0].id
  firewall_id = civo_firewall.sandbox.id
  sshkey_id   = var.ssh_public_key == "" ? null : civo_ssh_key.sandbox[0].id
  script      = file("\${path.module}/cloud-init.sh")
  tags        = ["nexux", "sandbox"]

  # Keep the generated root password in local state so the UI can reveal it.
  write_password = true
}

output "instance_id" {
  value = civo_instance.sandbox.id
}

output "public_ip" {
  value = civo_instance.sandbox.public_ip
}
`;
}

function renderAwsMainTf(): string {
  return `terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Credentials are read from the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# environment variables of the terraform process — never written to disk.
provider "aws" {
  region = var.region
}

variable "region" {
  type = string
}

variable "instance_name" {
  type = string
}

variable "size" {
  type = string
}

variable "disk_image" {
  type    = string
  default = "ubuntu-jammy"
}

variable "ssh_public_key" {
  type    = string
  default = ""
}

# Same disk_image identifiers as the Civo template, resolved to the latest
# official AMI for the region.
locals {
  images = {
    "ubuntu-jammy" = {
      owner   = "099720109477" # Canonical
      pattern = "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"
    }
    "ubuntu-focal" = {
      owner   = "099720109477"
      pattern = "ubuntu/images/hvm-ssd/ubuntu-focal-20.04-amd64-server-*"
    }
    "debian-11" = {
      owner   = "136693071363" # Debian
      pattern = "debian-11-amd64-*"
    }
  }
  image = lookup(local.images, var.disk_image, local.images["ubuntu-jammy"])
}

data "aws_ami" "sandbox" {
  most_recent = true
  owners      = [local.image.owner]

  filter {
    name   = "name"
    values = [local.image.pattern]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "sandbox" {
  count      = var.ssh_public_key == "" ? 0 : 1
  key_name   = "\${var.instance_name}-key"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "sandbox" {
  name        = "\${var.instance_name}-fw"
  description = "Nexus sandbox: SSH in, everything out"

  ingress {
    description = "ssh"
    protocol    = "tcp"
    from_port   = 22
    to_port     = 22
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "\${var.instance_name}-fw" }
}

resource "aws_instance" "sandbox" {
  ami                    = data.aws_ami.sandbox.id
  instance_type          = var.size
  key_name               = var.ssh_public_key == "" ? null : aws_key_pair.sandbox[0].key_name
  vpc_security_group_ids = [aws_security_group.sandbox.id]
  # Gzipped: EC2 caps user_data at 16 KB and the plain bootstrap exceeds it.
  # cloud-init detects the gzip magic bytes and decompresses transparently.
  user_data_base64       = filebase64("\${path.module}/cloud-init.sh.gz")

  # Default AMI volumes (8 GB) are too small for Docker + Chromium + repos.
  root_block_device {
    volume_size = 40
    volume_type = "gp3"
  }

  tags = {
    Name  = var.instance_name
    nexux = "sandbox"
  }
}

output "instance_id" {
  value = aws_instance.sandbox.id
}

output "public_ip" {
  value = aws_instance.sandbox.public_ip
}
`;
}

/**
 * Render a value for the right-hand side of a `.env` line.
 *
 * A raw value breaks the file in two ways: a newline turns the remainder into
 * bogus assignments (a pasted PEM key or JSON blob loses everything after its
 * first line), and a line that happens to equal the heredoc terminator ends the
 * file early, truncating every var after it.
 *
 * **Single** quotes, not double. A dotenv reader processes escapes inside
 * double quotes but takes a single-quoted value literally, and the values that
 * hurt here are service-account JSON — already full of `\"` and `\n` that mean
 * something to *JSON*. Double-quoting forces escaping the backslashes, and the
 * reader hands back `{\"type\"...}`, which no longer parses. Single quotes pass
 * the payload through untouched; verified against the `dotenv` package,
 * `node --env-file` and `set -a && . ./.env`.
 *
 * A value containing a single quote cannot be single-quoted (there is no escape
 * for it), so it falls back to double quotes with escapes — correct for real
 * newlines, and such values are not JSON payloads in practice.
 *
 * Values with no special characters are left bare so a normal `.env` still
 * reads like one.
 */
function dotenvQuote(value: string): string {
  if (value === "") return "";
  // Bare only when nothing can change meaning: no whitespace, quotes,
  // backslashes, `#`, or `$`.
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  if (!value.includes("'")) {
    // Literal — but real newlines still have to fold, or the value would span
    // lines again. `\n` inside single quotes stays two characters for a strict
    // reader; a JSON payload already encodes its newlines that way, which is
    // exactly the case this protects.
    return `'${value.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}'`;
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

/**
 * Unprivileged user the agent runs as. Claude Code refuses to bypass
 * permissions while running as root, and without bypass every Bash command
 * (install, test, git commit) is denied in headless mode.
 */
export const AGENT_USER = "nexus";

/**
 * The pre-rename agent user. Boxes provisioned before the `nexux` → `nexus`
 * rename own their checkouts as this account; bootstrap re-homes them onto
 * AGENT_USER rather than leaving a second uid owning /opt/nexus.
 */
export const LEGACY_AGENT_USER = "nexux";

/**
 * Where a keyless `tailscale up` parks its output. Separate from the bootstrap
 * log because that call is backgrounded and blocks until a human approves the
 * registration URL — the URL has to be greppable while the process still runs.
 */
export const TS_UP_LOG = "/var/log/nexus-tailscale-up.log";

/**
 * How the bootstrap announces a pending registration. A constant rather than
 * a literal in two files: the renderer writes it and `parseTailscaleAuthUrl`
 * reads it, and a rename that reached only one of them would fail silently —
 * the log would look right and the UI would show nothing.
 */
const TS_AUTH_URL_MARKER = "tailscale-auth-url=";

/**
 * Registration URL a keyless tailscale join printed, if the bootstrap log has
 * one yet. Returns null once the node is approved (the line stays in the log,
 * so callers should stop asking after the sandbox reports a tailnet address).
 */
export function parseTailscaleAuthUrl(bootstrapLog: string): string | null {
  // `\r?` because the log arrives over ssh, where a line ending is not always
  // the bare \n a Linux file was written with.
  const pattern = new RegExp(
    `^\\[nexux\\] ${TS_AUTH_URL_MARKER}(\\S+?)\\r?$`,
    "gm",
  );
  let url: string | null = null;
  for (const m of bootstrapLog.matchAll(pattern)) url = m[1];
  return url;
}

/**
 * Join the tailnet without an auth key, announcing the URL a human has to
 * approve. Shared by the bootstrap and by the on-demand "refresh session"
 * action, because the two must behave identically — a registration started one
 * way and finished the other is the normal case, and a second implementation
 * would be the one that drifts.
 *
 * Backgrounded: `tailscale up` blocks until the registration is approved, so
 * running it in the foreground would hold the bootstrap (or the HTTP request)
 * open until it timed out.
 */
/**
 * How long the bootstrap will hold for a human to approve an interactive
 * tailnet registration before giving up and carrying on regardless.
 */
export const TS_APPROVAL_TIMEOUT_SECONDS = 600;

/**
 * Block until the node is actually on the tailnet, or until the wait runs out.
 *
 * Only rendered for an interactive registration against a self-hosted control
 * plane, and only because in that setup the tailnet is what makes the git host
 * reachable at all: the bootstrap otherwise races a human, reaches the clone
 * seconds later, and loses — observed as
 * `Failed to connect to … port 443 after 130444 ms`, which reads as a network
 * fault rather than as "nobody has clicked the link yet". With an auth key
 * there is nothing to wait for (`tailscale up` returns already joined), and on
 * Tailscale's own control plane a project's repos are not usually behind the
 * tailnet, so neither case pays this cost.
 *
 * It waits *late* — after every install that needs no tailnet — so the human
 * has the whole rest of the bootstrap to approve, and the wait is usually over
 * before it begins.
 *
 * Times out into a WARN rather than an abort: a machine with tooling and no
 * checkout is still worth something, and aborting would leave nothing at all.
 */
export function renderTailscaleApprovalWait(opts: {
  name: string;
  timeoutSeconds?: number;
}): string {
  const timeout = opts.timeoutSeconds ?? TS_APPROVAL_TIMEOUT_SECONDS;
  return `echo "[nexux] waiting for the tailnet registration to be approved (up to ${Math.round(timeout / 60)}m)"
echo "[nexux] nothing behind the tailnet — a self-hosted git host included — is reachable until it is"
# Traced, this loop writes several lines per poll for as long as the wait runs,
# which would push its own re-announced link back out of the 400-line tail the
# UI reads — the exact problem the re-announcement exists to solve. No secrets
# here; this is purely about not drowning the log.
set +x
ts_ip=""
ts_waited=0
while [ "$ts_waited" -lt ${timeout} ]; do
  ts_ip="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "$ts_ip" ] && break
  # Re-announce the URL every 30s. The UI reads a 400-line tail of this log,
  # and the original announcement is far enough back by now to have scrolled
  # out of it — a link nobody can find is the same as no link.
  if [ $((ts_waited % 30)) -eq 0 ]; then
    ts_url=$(grep -Eo '^[[:space:]]*https://[^[:space:]]+$' ${TS_UP_LOG} 2>/dev/null | head -1 | tr -d '[:space:]')
    [ -n "$ts_url" ] && echo "[nexux] ${TS_AUTH_URL_MARKER}$ts_url"
  fi
  sleep 5
  ts_waited=$((ts_waited + 5))
done
set -x
if [ -n "$ts_ip" ]; then
  echo "[nexux] tailnet registration approved after \${ts_waited}s: $ts_ip"
else
  echo "[nexux] WARN: not approved after ${timeout}s — continuing anyway"
  echo "[nexux] WARN: clones from a host behind the tailnet will fail; approve the link and re-create the sandbox"
fi`;
}

export function renderTailscaleLogin(opts: {
  /** Machine name on the tailnet. */
  name: string;
  /** `--login-server` for a self-hosted control plane; omitted for Tailscale's. */
  loginServer?: string | null;
  /** How long to wait for the URL to show up. */
  waitSeconds?: number;
}): string {
  const server = opts.loginServer?.trim().replace(/\/+$/, "");
  const loginServerFlag = server
    ? `\n  --login-server=${shq(server)} \\`
    : "";
  const wait = opts.waitSeconds ?? 30;
  return `rm -f ${TS_UP_LOG}
(tailscale up \\${loginServerFlag}
  --hostname=${shq(opts.name)} \\
  --ssh \\
  --accept-routes \\
  --accept-dns=false > ${TS_UP_LOG} 2>&1 &)
ts_url=""
for i in $(seq 1 ${wait}); do
  # Anchored to a whole line: tailscale prints the registration URL indented on
  # one of its own, while its error messages carry help links inline — matching
  # any https:// in the log would hand the UI one of those instead.
  ts_url=$(grep -Eo '^[[:space:]]*https://[^[:space:]]+$' ${TS_UP_LOG} 2>/dev/null | head -1 | tr -d '[:space:]')
  [ -n "$ts_url" ] && break
  tailscale status >/dev/null 2>&1 && break
  sleep 1
done
if [ -n "$ts_url" ]; then
  # Parsed out of the output by the UI — keep the key=value shape.
  echo "[nexux] ${TS_AUTH_URL_MARKER}$ts_url"
  echo "[nexux] ACTION REQUIRED: open that URL to approve ${opts.name} on the tailnet"
elif tailscale status >/dev/null 2>&1; then
  echo "[nexux] tailscale joined as ${opts.name}: $(tailscale ip -4 2>/dev/null | head -1)"
else
  echo "[nexux] WARN: tailscale up produced no auth URL — join manually with 'tailscale up'"
fi`;
}

/** DNS/path-safe identifier for checkout directories. */
export { safeSlug };

function renderEnvExports(envVars: Record<string, string>): string {
  const entries = Object.entries(envVars);
  const exports = entries.map(([k, v]) => `export ${k}=${shq(v)}`);
  // Shared browser cache so the agent user finds the Chromium root installed.
  exports.push(`export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`);
  // pnpm 11 aborts an install whose dependencies have unapproved build scripts
  // (ERR_PNPM_IGNORED_BUILDS), and `pnpm <script>` runs that check before the
  // script — so an unattended `pnpm dev` dies before the app ever binds, and
  // the failure surfaces as "did not answer on port N". Approving builds is
  // interactive, which a sandbox has no way to satisfy. The setting is named
  // for the trade it makes, and a disposable container is where it holds.
  exports.push(`export PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true`);
  // V8 settles on a ~2 GB heap whatever the box has, so a dev server on a large
  // repo dies with "Ineffective mark-compacts near heap limit" while most of the
  // machine sits idle — and it dies *after* the tunnel is up, which reads as
  // "the tunnel is broken" rather than as an OOM. Sized from the memory the
  // container can actually see, and computed when the file is sourced so a
  // resized box needs no re-bootstrap. A ceiling, not a reservation: nothing is
  // consumed until the process grows into it. Never overrides a project that
  // set NODE_OPTIONS itself.
  exports.push(
    `export NODE_OPTIONS="\${NODE_OPTIONS:---max-old-space-size=` +
      `\$(awk '/MemTotal/ {print int(\$2/1024*3/4)}' /proc/meminfo)}"`,
  );
  // Vite refuses a request whose Host it does not recognise, so a dev server
  // reached through the preview tunnel answers "Blocked request. This host is
  // not allowed" instead of the app. The quick tunnel's hostname is random per
  // run, so no repo can list it ahead of time — and requiring one would put the
  // burden on every Vite project (Astro, SvelteKit, Nuxt, Remix…). A leading
  // dot is Vite's own wildcard: `hostname.endsWith(allowedHost)`. Only the
  // tunnel domain is opened, and only additively — a project's own
  // allowedHosts survives, since Vite concatenates rather than replaces.
  exports.push(
    `export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com`,
  );
  return `cat > /etc/profile.d/nexus-env.sh <<'NEXUX_ENV_EOF'
${exports.join("\n")}
NEXUX_ENV_EOF
chmod 644 /etc/profile.d/nexus-env.sh
# Pre-rename .bashrc files still source nexux-env.sh. Replace that file with a
# symlink rather than leaving it: a stale copy would keep exporting the values
# this bootstrap just superseded, and profile.d sources both in sequence.
rm -f /etc/profile.d/nexux-env.sh
ln -s /etc/profile.d/nexus-env.sh /etc/profile.d/nexux-env.sh
`;
}

/**
 * Run a command in `dir` as the agent user.
 *
 * Bootstrap is root (cloud-init has no choice), but everything that writes
 * *inside* a checkout must not be: the dev servers, the agent and the terminal
 * all run as AGENT_USER, and a root-owned `node_modules` / `.next` / `lib`
 * makes them fail with EACCES later. A trailing `chown` cannot fix this
 * reliably — anything writing after it (a launcher's emulator data, a later
 * `git fetch`) re-creates root-owned paths behind its back.
 *
 * `runuser` over `su`: it takes the command as argv rather than re-parsing a
 * string, so nothing here has to survive a second round of shell quoting.
 */
function asAgent(dir: string, command: string): string {
  return `runuser -u ${AGENT_USER} -- bash -lc ${shq(`cd ${shq(dir)} && ${command}`)}`;
}

function renderRepoSection(repo: SandboxRepoSpec): string {
  const dir = `/opt/nexus/${safeSlug(repo.name)}`;
  // Mounted repos (local provider, no clone URL) are already bind-mounted at
  // `dir` by the container launch — skip the clone, keep .env + install.
  // Clone as the agent user so the checkout — including .git, which a later
  // `git fetch`/`git commit` rewrites — is owned by it from the start.
  const clone = (branch?: string) =>
    `runuser -u ${AGENT_USER} -- git clone ${branch ? `-b ${shq(branch)} ` : ""}${shq(repo.repoUrl!)} ${shq(dir)}`;

  // Lazy: a mounted repo has no URL at all, and building the chain eagerly
  // would call shq(null) before the branch below ever decides not to clone.
  // The main checkout is the cd target of every agent task, so its clone
  // failing is fatal rather than a warning: the sandbox used to provision
  // "successfully" without it and then fail each task with a bare
  // `cd: /opt/nexus/<repo>: No such file or directory` — an error that names
  // the symptom an hour after the cause scrolled past in the bootstrap log.
  const onCloneFailure = repo.isMain
    ? `nexus_bootstrap_fatal "clone failed for ${repo.name} (the main checkout — every task runs in ${dir})"`
    : `echo "[nexux] WARN: clone failed for ${repo.name}"`;

  const cloneChain = () =>
    repo.branch
      ? `${clone(repo.branch)} || { echo "[nexux] WARN: branch ${repo.branch} not found for ${repo.name} — cloning default branch"; ${clone()}; } || ${onCloneFailure}`
      : `${clone()} || ${onCloneFailure}`;

  const lines: string[] = repo.repoUrl
    ? [
        // The parent must exist and be agent-owned before runuser can write it.
        `mkdir -p /opt/nexus && chown ${AGENT_USER}:${AGENT_USER} /opt/nexus`,
        // An existing checkout is adopted, never re-cloned. This block is run
        // again by the retry action, and re-cloning would mean deleting a tree
        // that may hold work — the expensive mistake, against a clone that is
        // merely redundant. The install/build below still re-runs, which is
        // usually the half that failed.
        `if [ -d ${shq(`${dir}/.git`)} ]; then
  echo "[nexux] ${repo.name} already checked out — keeping it"
else
  echo "[nexux] cloning ${repo.name}"
  ${cloneChain()}
fi`,
      ]
    : [
        `echo "[nexux] using mounted workspace for ${repo.name}"`,
        repo.isMain
          ? `[ -d ${shq(dir)} ] || nexus_bootstrap_fatal "mount missing for ${repo.name} (${dir}) — the main checkout"`
          : `[ -d ${shq(dir)} ] || echo "[nexux] WARN: mount missing for ${repo.name} (${shq(dir)})"`,
        // A bind-mounted checkout arrives with the host's uid; the agent still
        // has to be able to install into it.
        `[ -d ${shq(dir)} ] && chown -R ${AGENT_USER}:${AGENT_USER} ${shq(dir)} || true`,
      ];

  const envEntries = Object.entries(repo.envVars ?? {});
  if (envEntries.length > 0) {
    const dotenv = envEntries.map(([k, v]) => `${k}=${dotenvQuote(v)}`).join("\n");
    lines.push(
      `cat > ${shq(`${dir}/.env`)} <<'NEXUX_DOTENV_EOF'
${dotenv}
NEXUX_DOTENV_EOF`,
      `chmod 600 ${shq(`${dir}/.env`)}`,
      // Written by root (the heredoc keeps the secrets out of argv); 0600 would
      // otherwise leave the agent unable to read its own .env.
      `chown ${AGENT_USER}:${AGENT_USER} ${shq(`${dir}/.env`)}`,
    );
  }

  if (repo.installCommand) {
    lines.push(
      `${asAgent(dir, repo.installCommand)} || echo "[nexux] WARN: install failed for ${repo.name}"`,
    );
  } else {
    // No install command configured — infer one from the lockfile so the agent
    // finds a ready workspace instead of an empty node_modules.
    //
    // `bun`/`corepack` install globally, which the agent user cannot do, so
    // those two steps stay with root; only the install itself drops privileges.
    lines.push(`if [ -f ${shq(`${dir}/package.json`)} ]; then
  echo "[nexux] no install command for ${repo.name} — inferring from lockfile"
  if [ -f ${shq(`${dir}/bun.lockb`)} ] || [ -f ${shq(`${dir}/bun.lock`)} ]; then
    command -v bun >/dev/null || npm install -g bun
    ${asAgent(dir, "bun install")} || echo "[nexux] WARN: inferred install failed for ${repo.name}"
  elif [ -f ${shq(`${dir}/pnpm-lock.yaml`)} ]; then
    corepack enable
    ${asAgent(dir, "pnpm install")} || echo "[nexux] WARN: inferred install failed for ${repo.name}"
  elif [ -f ${shq(`${dir}/yarn.lock`)} ]; then
    corepack enable
    ${asAgent(dir, "yarn install")} || echo "[nexux] WARN: inferred install failed for ${repo.name}"
  else
    ${asAgent(dir, "npm install")} || echo "[nexux] WARN: inferred install failed for ${repo.name}"
  fi
fi`);
  }
  if (repo.buildCommand) {
    lines.push(
      `${asAgent(dir, repo.buildCommand)} || echo "[nexux] WARN: build failed for ${repo.name}"`,
    );
  }
  return lines.join("\n");
}

export type BootstrapMode = "cloud" | "container";

export function renderCloudInit(
  spec: SandboxSpec,
  opts: { mode?: BootstrapMode; generatedAt?: string } = {},
): string {
  const mode: BootstrapMode = opts.mode ?? "cloud";
  const sections: string[] = [];

  sections.push(`#!/bin/bash
# Nexus sandbox bootstrap — generated for instance "${spec.name}".
exec > >(tee -a /var/log/nexus-bootstrap.log) 2>&1
set -ux
export DEBIAN_FRONTEND=noninteractive
# cloud-init runs as root but may not set HOME; several tools need it.
export HOME="\${HOME:-/root}"

echo "[nexux] bootstrap started $(date -Is)"

# A step the sandbox cannot be useful without. Records the reason and keeps
# going: the rest of the run still installs tooling and writes logs, and the
# final section refuses to write the completion marker while this file exists.
# Aborting outright would lose that diagnostic context, and cloud-init runs
# without "set -e" anyway (see D-33), so an early exit is not reliable either.
nexus_bootstrap_fatal() {
  mkdir -p ${SANDBOX_ROOT}
  echo "\$1" >> ${BOOTSTRAP_FAILED_MARKER}
  echo "[nexux] FATAL: \$1"
}

# apt-get, but not while something else holds the dpkg lock.
#
# Ubuntu's cloud images start unattended-upgrades on first boot — which is
# exactly when this bootstrap runs. Whichever install lands in that window dies
# on "Could not get lock /var/lib/dpkg/lock-frontend", and since every install
# here degrades to a WARN rather than aborting, the box finishes bootstrapping
# and reports success with a tool silently missing. Observed on a sandbox that
# answered "command not found" for a CLI a bootstrap had claimed to install,
# hours after the WARN saying so had scrolled out of the 400-line tail the UI
# reads.
#
# Retries rather than forces: the lock is held by a process that is mid-dpkg,
# and taking it away leaves a half-configured package database. Retries rather
# than polls, too, because the probe for "is it free" is the install itself —
# no dependency on fuser/lsof, which the minimal images do not all ship.
#
# Piped through tee, not captured: an apt install runs for minutes and the UI
# tails this log live, so buffering its output would look like a hang.
nexus_apt() {
  local waited=0 rc
  while :; do
    apt-get "$@" 2>&1 | tee /tmp/nexus-apt.log
    rc=\${PIPESTATUS[0]}
    [ "$rc" -eq 0 ] && return 0
    grep -qi 'could not get lock\\|unable to acquire the dpkg' /tmp/nexus-apt.log || return "$rc"
    [ "$waited" -ge 300 ] && { echo "[nexux] WARN: dpkg still locked after \${waited}s — giving up on 'apt-get $*'"; return "$rc"; }
    echo "[nexux] dpkg is locked (unattended-upgrades?) — retrying 'apt-get $1' in 10s (\${waited}s elapsed)"
    sleep 10
    waited=$((waited + 10))
  done
}

# Block until the package database is free. For the installers this script does
# not run through apt itself — vendor 'curl … | sh' scripts and 'dpkg -i' — the
# wrapper above cannot retry them, so wait for the lock before starting. The
# probe is 'apt-get check': it takes the same lock, and nexus_apt already knows
# how to wait for it.
nexus_dpkg_wait() { nexus_apt check >/dev/null 2>&1 || true; }

# Claude Code refuses to run with bypassed permissions as root, so the agent
# runs as this unprivileged user. It owns the checkouts under /opt/nexus.
# Created before the apt installs below, which take minutes on a small
# instance: SSH access (this user plus the authorized keys) must not wait on
# them — "instance ready" used to be followed by minutes of publickey denials.
echo "[nexux] creating agent user"
id -u ${AGENT_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${AGENT_USER}
# Passwordless sudo: the agent may need it for system-level setup steps.
echo '${AGENT_USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${AGENT_USER}
chmod 440 /etc/sudoers.d/${AGENT_USER}`);

  // Providers install the terraform-registered key for their initial user
  // ("civo" on Civo, "ubuntu" on AWS Ubuntu AMIs), not root — re-authorize
  // every key for root, which is what the in-app terminal and the
  // bootstrap-managed checkouts use.
  const authorizedKeys = [spec.sshPublicKey ?? "", ...(spec.authorizedKeys ?? [])]
    .map((k) => k.trim())
    .filter(Boolean);
  if (mode === "container") {
    // No sshd in a container — everything execs through `docker exec`.
  } else if (authorizedKeys.length > 0) {
    // Both accounts: root for the in-app terminal, the agent user for tasks.
    // OVERWRITE, don't append: Ubuntu AMIs pre-seed /root/.ssh/authorized_keys
    // with a command="Please login as ubuntu" entry for the same key, and sshd
    // uses the first matching entry — an appended clean copy is never reached.
    sections.push(`echo "[nexux] authorizing SSH keys"
for d in /root /home/${AGENT_USER}; do
  mkdir -p "$d/.ssh" && chmod 700 "$d/.ssh"
  cat > "$d/.ssh/authorized_keys" <<'NEXUX_KEYS_EOF'
${authorizedKeys.join("\n")}
NEXUX_KEYS_EOF
  chmod 600 "$d/.ssh/authorized_keys"
done
chown -R ${AGENT_USER}:${AGENT_USER} /home/${AGENT_USER}/.ssh`);
  }

  sections.push(`nexus_apt update -y
# build-essential brings make/gcc/g++: repo Makefiles and node-gyp native deps
# both die without them, and the base cloud images ship neither.
nexus_apt install -y git curl ca-certificates gnupg build-essential

# Migration: this tree was /opt/nexux (owned by the '${LEGACY_AGENT_USER}' user)
# before the rename. Re-bootstrapping such a box must not strand its checkouts
# behind the old name, so move the directory once and leave a symlink pointing
# forward — anything still holding a /opt/nexux path keeps resolving.
#
# Guarded on the real-directory case: on a box that already migrated,
# /opt/nexux is the symlink and moving it would make it point at itself.
if [ -d /opt/nexux ] && [ ! -L /opt/nexux ]; then
  if [ -e /opt/nexus ]; then
    echo "[nexux] WARN: both /opt/nexux and /opt/nexus exist — leaving /opt/nexux alone"
  else
    echo "[nexux] migrating /opt/nexux -> /opt/nexus"
    mv /opt/nexux /opt/nexus
    ln -s /opt/nexus /opt/nexux
  fi
fi

mkdir -p /opt/nexus
# Compat shim for anything provisioned before the rename: stale PID files,
# a VS Code window reopened on its last folder, a shell with the old path in
# its history. Cheap to keep, and its absence is a confusing ENOENT.
[ -e /opt/nexux ] || ln -s /opt/nexus /opt/nexux

# Also re-homes legacy checkouts owned by the old uid, so installs and git
# writes don't start failing with EACCES after the rename.
chown -R ${AGENT_USER}:${AGENT_USER} /opt/nexus
# Root and the agent share the checkouts — don't let git cry about ownership.
git config --system --add safe.directory '*' || true`);

  const envBlock = renderEnvExports(spec.envVars);
  if (envBlock) {
    sections.push(`echo "[nexux] writing project environment variables"
${envBlock}
# profile.d only reaches login shells; VS Code remote terminals spawn
# non-login interactive bash, so source it from bashrc too.
#
# Legacy rc files point at nexux-env.sh. That still resolves through the compat
# symlink, but the guard below greps for the new name — without the rewrite it
# would append a second line and every shell would source the file twice.
for rc in /root/.bashrc /home/${AGENT_USER}/.bashrc /home/${LEGACY_AGENT_USER}/.bashrc; do
  [ -f "$rc" ] || continue
  sed -i 's#/etc/profile.d/nexux-env\.sh#/etc/profile.d/nexus-env.sh#g' "$rc" || true
  grep -qs "nexus-env.sh" "$rc" || \\
    echo '[ -f /etc/profile.d/nexus-env.sh ] && . /etc/profile.d/nexus-env.sh' >> "$rc"
done`);
  }

  if (
    spec.installNode ||
    spec.installClaudeCode ||
    spec.installOpenCode ||
    spec.installAgentBrowser
  ) {
    sections.push(`echo "[nexux] installing Node.js 22"
nexus_dpkg_wait
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
nexus_apt install -y nodejs`);
  }

  // pnpm and yarn ship as corepack shims, not as binaries: without an explicit
  // `corepack prepare … --activate` they only exist inside a step that ran
  // `corepack enable` itself. The preview script and the agent get a fresh
  // shell, so `pnpm dev` there dies on "pnpm: not found". Materialize the
  // shims once, globally, whenever Node is on the box.
  if (
    spec.installNode ||
    spec.installClaudeCode ||
    spec.installOpenCode ||
    spec.installAgentBrowser
  ) {
    sections.push(`echo "[nexux] enabling corepack (pnpm, yarn)"
corepack enable || echo "[nexux] WARN: corepack enable failed"
corepack prepare pnpm@latest --activate || echo "[nexux] WARN: pnpm activate failed"
corepack prepare yarn@stable --activate || echo "[nexux] WARN: yarn activate failed"`);
  }

  // A repo whose install/build/run commands call bun needs the real binary —
  // Node alone won't cover it, and the preview/agent runs die on "bun: not
  // found". The npm package ships the actual bun executable.
  const needsBun = spec.repos.some((r) =>
    [r.installCommand, r.buildCommand, r.runCommand].some(
      (c) => c && /\bbun\b/.test(c),
    ),
  );
  if (needsBun) {
    sections.push(`echo "[nexux] installing bun (repo commands use it)"
npm install -g bun || echo "[nexux] WARN: bun install failed"`);
  }

  if (spec.installDocker) {
    if (mode === "container") {
      // No systemd inside a container: install the engine, then start dockerd
      // by hand (docker-in-docker — the sandbox container runs --privileged).
      sections.push(`echo "[nexux] installing Docker (dind)"
nexus_dpkg_wait
curl -fsSL https://get.docker.com | sh || echo "[nexux] WARN: docker install failed"
usermod -aG docker ${AGENT_USER} || true
if [ ! -S /var/run/docker.sock ]; then
  echo "[nexux] starting dockerd"
  (dockerd > /var/log/dockerd.log 2>&1 &)
  for i in $(seq 1 30); do [ -S /var/run/docker.sock ] && break; sleep 1; done
  [ -S /var/run/docker.sock ] || echo "[nexux] WARN: dockerd did not come up"
fi`);
    } else {
      sections.push(`echo "[nexux] installing Docker"
nexus_dpkg_wait
curl -fsSL https://get.docker.com | sh || echo "[nexux] WARN: docker install failed"
usermod -aG docker ${AGENT_USER} || true`);
    }
  }

  // Stack services (databases, caches) come up before repos are cloned so
  // install/build/tests find their dependencies already listening.
  const stackYaml = spec.stackComposeYaml?.trim();
  if (stackYaml) {
    if (/^NEXUX_STACK_EOF$/m.test(stackYaml)) {
      throw new Error(
        "stack compose YAML contains the heredoc sentinel NEXUX_STACK_EOF",
      );
    }
    const names = (spec.stackServiceNames ?? []).join(", ");
    sections.push(`echo "[nexux] starting stack services${names ? `: ${names}` : ""}"
mkdir -p /opt/nexus/stack
cat > /opt/nexus/stack/docker-compose.yml <<'NEXUX_STACK_EOF'
${stackYaml}
NEXUX_STACK_EOF
if command -v docker >/dev/null 2>&1; then
  (cd /opt/nexus/stack && docker compose up -d --wait --wait-timeout 180) \\
    || echo "[nexux] WARN: stack services failed to start (repos may miss their dependencies)"
else
  echo "[nexux] WARN: docker not available — stack services skipped (enable the Docker toggle)"
fi`);
  }

  if (spec.installClaudeCode) {
    // Persist the token in Claude Code's own settings (settings.json `env`
    // applies to every session), so interactive `claude` authenticates even
    // where the shell env is absent — not just in login shells. Onboarding
    // is pre-completed in .claude.json: without it the first interactive run
    // shows the "Select login method" picker even when the token is set.
    // Both accounts: the agent user runs tasks / VS Code, root is what the
    // in-app terminal logs in as.
    const claudeToken = spec.envVars.CLAUDE_CODE_OAUTH_TOKEN;
    // Always written: commits/PRs must not carry Claude's attribution
    // footer ("Generated with Claude Code" / Co-Authored-By) — the work is
    // authored by the token owner (D-18). The token env rides along when set.
    // The configured model rides along: a delegated task passes `--model` per
    // invocation, but an interactive `claude` in the in-app terminal only reads
    // this file — so picking Opus in Sandbox settings used to hold for tasks
    // and silently not for the terminal on the same sandbox.
    const claudeModel = spec.claudeModel?.trim();
    const claudeSettings = JSON.stringify(
      {
        includeCoAuthoredBy: false,
        ...(claudeModel ? { model: claudeModel } : {}),
        ...(claudeToken
          ? { env: { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } }
          : {}),
      },
      null,
      2,
    );
    // ~/.claude.json: pre-completed onboarding plus the project's MCP servers
    // (user scope — headless runs load them without interactive approval).
    const hasMcp =
      spec.mcpServers && Object.keys(spec.mcpServers).length > 0;
    const claudeJson = JSON.stringify(
      hasMcp
        ? { hasCompletedOnboarding: true, mcpServers: spec.mcpServers }
        : { hasCompletedOnboarding: true },
      null,
      2,
    );
    if (/^NEXUX_CLAUDEJSON_EOF$/m.test(claudeJson)) {
      throw new Error(
        "mcp servers config contains the heredoc sentinel NEXUX_CLAUDEJSON_EOF",
      );
    }
    sections.push(`echo "[nexux] installing Claude Code"
npm install -g @anthropic-ai/claude-code || echo "[nexux] WARN: claude code install failed"${
      hasMcp ? `\necho "[nexux] configuring ${Object.keys(spec.mcpServers!).length} MCP server(s)"` : ""
    }
for h in /root /home/${AGENT_USER}; do
  mkdir -p "$h/.claude"
  cat > "$h/.claude/settings.json" <<'NEXUX_CLAUDE_EOF'
${claudeSettings}
NEXUX_CLAUDE_EOF
  chmod 600 "$h/.claude/settings.json"
  cat > "$h/.claude.json" <<'NEXUX_CLAUDEJSON_EOF'
${claudeJson}
NEXUX_CLAUDEJSON_EOF
done
chown -R ${AGENT_USER}:${AGENT_USER} /home/${AGENT_USER}/.claude /home/${AGENT_USER}/.claude.json`);
  }

  if (spec.installOpenCode) {
    // OpenCode reads provider API keys straight from the env
    // (OPENAI_API_KEY, OPENROUTER_API_KEY, ... — injected via profile.d), so
    // no auth.json is needed. The config file pins the model and opens
    // permissions: sandbox runs are unattended, the instance is disposable.
    // Both accounts, like Claude Code: agent user runs tasks, root is the
    // in-app terminal.
    const model = spec.openCodeModel?.trim();
    const openCodeConfig = JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        permission: { "*": "allow" },
        ...(model ? { model } : {}),
      },
      null,
      2,
    );
    if (/^NEXUX_OPENCODE_EOF$/m.test(openCodeConfig)) {
      throw new Error(
        "opencode config contains the heredoc sentinel NEXUX_OPENCODE_EOF",
      );
    }
    sections.push(`echo "[nexux] installing OpenCode"
npm install -g opencode-ai || echo "[nexux] WARN: opencode install failed"
for h in /root /home/${AGENT_USER}; do
  mkdir -p "$h/.config/opencode"
  cat > "$h/.config/opencode/opencode.json" <<'NEXUX_OPENCODE_EOF'
${openCodeConfig}
NEXUX_OPENCODE_EOF
  chmod 600 "$h/.config/opencode/opencode.json"
done
chown -R ${AGENT_USER}:${AGENT_USER} /home/${AGENT_USER}/.config`);
  }

  if (spec.installCloudflared) {
    // Quick tunnels (trycloudflare.com) need no Cloudflare account: they give
    // the running app a public https URL so a PR can be reviewed live.
    sections.push(`echo "[nexux] installing cloudflared"
nexus_dpkg_wait
ARCH=$(dpkg --print-architecture)
curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-\${ARCH}.deb" -o /tmp/cloudflared.deb && \\
  dpkg -i /tmp/cloudflared.deb || echo "[nexux] WARN: cloudflared install failed"
rm -f /tmp/cloudflared.deb`);
  }

  if (spec.installTailscale) {
    const authKey = spec.tailscaleAuthKey?.trim();
    const loginServer = spec.tailscaleLoginServer?.trim().replace(/\/+$/, "");
    // Only present for a self-hosted control plane; Tailscale's own is the
    // default and passing it explicitly would just be noise.
    const loginServerFlag = loginServer
      ? `\n  --login-server=${shq(loginServer)} \\`
      : "";
    // Containers have no systemd; run tailscaled by hand, falling back to
    // userspace networking when /dev/net/tun is absent.
    const daemon =
      mode === "container"
        ? `TS_FLAGS=""
[ -e /dev/net/tun ] || TS_FLAGS="--tun=userspace-networking"
if ! pgrep -x tailscaled >/dev/null 2>&1; then
  mkdir -p /var/lib/tailscale
  (tailscaled $TS_FLAGS --state=/var/lib/tailscale/tailscaled.state > /var/log/tailscaled.log 2>&1 &)
  sleep 2
fi`
        : `systemctl enable --now tailscaled`;
    // The auth key is a secret and this script is tee'd to a log — trace off
    // around the join, and the key travels via a 0600 file removed after.
    // Unlike Nexus hosts nothing downstream depends on the tailnet address,
    // so a failed join degrades to a WARN instead of aborting the bootstrap.
    //
    // `--accept-routes` is the whole point of joining: a tailnet's subnet
    // routers are how an internal service becomes reachable, and without it a
    // sandbox silently sends that traffic out its public gateway instead. The
    // failure is a *timeout* on a host that resolves fine and answers on other
    // ports, which reads as anything but a missing flag. Diagnosed on a box
    // whose git server published `34.105.191.153/32` over the tailnet: ssh
    // (public) worked, https (internal) hung, and the token auth that every
    // clone depends on goes over https.
    //
    // `--accept-dns` deliberately stays off. Routes add reachability; taking
    // the tailnet's resolver *replaces* the sandbox's, and a tailnet that
    // resolves poorly (or not at all) for public names would break apt, npm
    // and every clone — a much larger blast radius than the problem it solves.
    const join = authKey
      ? `set +x
umask 077
printf '%s' ${shq(authKey)} > /root/.tskey
tailscale up \\
  --authkey="$(cat /root/.tskey)" \\${loginServerFlag}
  --hostname=${shq(spec.name)} \\
  --ssh \\
  --accept-routes \\
  --accept-dns=false
ts_rc=$?
rm -f /root/.tskey
set -x
umask 022
if [ "$ts_rc" -ne 0 ]; then
  echo "[nexux] WARN: tailscale up failed (rc=$ts_rc) — join manually with 'tailscale up'"
else
  echo "[nexux] tailscale joined as ${spec.name}: $(tailscale ip -4 2>/dev/null | head -1)"
fi`
      : // No key: register interactively instead of giving up. A self-hosted
        // control plane (Headscale) has no admin console to mint a key from
        // unless you run the server, so this is the only route a normal user
        // has — `tailscale up` prints a URL, a human approves it in a browser
        // where they are already signed in, and the node joins under their own
        // account. The same renderer backs the on-demand "refresh session"
        // action, so a registration begun here can be finished from the UI.
        renderTailscaleLogin({
          name: spec.name,
          loginServer,
        });
    sections.push(`echo "[nexux] installing tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  # Tailscale's installer shells out to apt itself, so nexus_apt cannot wrap
  # it — wait for the lock here instead. This is the install that got caught
  # by unattended-upgrades and left a sandbox off the tailnet.
  nexus_dpkg_wait
  curl -fsSL https://tailscale.com/install.sh | sh || echo "[nexux] WARN: tailscale install failed"
fi
if command -v tailscale >/dev/null 2>&1; then
${daemon}
${join}
else
  # Said out loud, and said last: without this the only trace of a failed
  # install is a WARN hundreds of lines earlier, and every downstream symptom
  # ("no registration URL", clones timing out against a host behind the
  # tailnet) points somewhere else entirely.
  echo "[nexux] WARN: tailscale is not installed — this sandbox will not join the tailnet"
  echo "[nexux] WARN: install it with 'curl -fsSL https://tailscale.com/install.sh | sh', then use Refresh Tailscale session"
fi`);
  }

  // gh authenticates from GITHUB_TOKEN — no interactive login needed.
  sections.push(`echo "[nexux] installing GitHub CLI"
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \\
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \\
  nexus_apt update -y && nexus_apt install -y gh || echo "[nexux] WARN: gh install failed"
git config --system user.name "Nexus Agent" || true
git config --system user.email "agent@nexux.local" || true`);

  // glab authenticates from GITLAB_TOKEN — needed for MR creation on GitLab
  // repos. Latest release via the API, pinned fallback if that lookup fails.
  sections.push(`echo "[nexux] installing GitLab CLI"
GLAB_TAG=$(curl -fsSL --max-time 20 "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest" | grep -o '"tag_name":"v[^"]*"' | head -1 | cut -d'"' -f4)
GLAB_TAG=\${GLAB_TAG:-v1.108.0}
GLAB_VER=\${GLAB_TAG#v}
GLAB_ARCH=$(dpkg --print-architecture)
nexus_dpkg_wait
curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/\${GLAB_TAG}/downloads/glab_\${GLAB_VER}_linux_\${GLAB_ARCH}.deb" -o /tmp/glab.deb && \\
  dpkg -i /tmp/glab.deb || echo "[nexux] WARN: glab install failed"
rm -f /tmp/glab.deb`);

  // Commits should be authored by the token's owner, not a generic bot:
  // resolve the identity from whichever git host token is present. GitHub
  // uses the noreply address (always valid; respects "block private email"
  // push protection); GitLab uses the account's commit_email. The primary
  // host (the main repo's) is asked first; the "Nexus Agent" identity set
  // above stays only as a last-resort fallback.
  const primaryIsGitLab = (() => {
    const url = spec.repos[0]?.repoUrl ?? "";
    const glHost = (spec.envVars.GITLAB_HOST ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    return /gitlab/i.test(url) || (glHost !== "" && url.includes(glHost));
  })();
  const githubIdentity = `if [ -z "\$GIT_ID_SET" ] && [ -n "\${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GH_LOGIN=$(gh api user -q .login 2>/dev/null)
  GH_ID=$(gh api user -q .id 2>/dev/null)
  GH_NAME=$(gh api user -q '.name // .login' 2>/dev/null)
  if [ -n "\$GH_LOGIN" ] && [ -n "\$GH_ID" ]; then
    set_git_identity "\${GH_NAME:-\$GH_LOGIN}" "\${GH_ID}+\${GH_LOGIN}@users.noreply.github.com" && GIT_ID_SET=1
  fi
fi`;
  const gitlabIdentity = `if [ -z "\$GIT_ID_SET" ] && [ -n "\${GITLAB_TOKEN:-}" ]; then
  GL_API_HOST="\${GITLAB_HOST:-gitlab.com}"
  GL_API_HOST="\${GL_API_HOST#https://}"; GL_API_HOST="\${GL_API_HOST#http://}"; GL_API_HOST="\${GL_API_HOST%%/*}"
  # Trace off: the token rides in the PRIVATE-TOKEN header and \`set -x\` would
  # echo the whole curl line into the bootstrap log.
  set +x
  GL_JSON=$(curl -fsS --max-time 20 -H "PRIVATE-TOKEN: \${GITLAB_TOKEN}" "https://\${GL_API_HOST}/api/v4/user" 2>/dev/null)
  set -x
  GL_NAME=$(printf %s "\$GL_JSON" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
  GL_EMAIL=$(printf %s "\$GL_JSON" | grep -o '"commit_email":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ -n "\$GL_EMAIL" ] || GL_EMAIL=$(printf %s "\$GL_JSON" | grep -o '"email":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "\$GL_NAME" ] && [ -n "\$GL_EMAIL" ]; then
    set_git_identity "\$GL_NAME" "\$GL_EMAIL" && GIT_ID_SET=1
  fi
fi`;
  // Everything from here needs the git host: the identity lookup hits its API
  // and the clones follow. On a self-hosted tailnet that host is only
  // reachable once a human has approved this node, so this is where the
  // bootstrap stops guessing and waits.
  const needsTailnetApproval =
    Boolean(spec.installTailscale) &&
    !spec.tailscaleAuthKey?.trim() &&
    Boolean(spec.tailscaleLoginServer?.trim());
  if (needsTailnetApproval) {
    sections.push(renderTailscaleApprovalWait({ name: spec.name }));
  }

  sections.push(`echo "[nexux] resolving git identity from the token owner"
# Trace off around the source: xtrace echoes every \`export\` the file contains,
# which is every project secret verbatim into a log the UI serves.
set +x
. /etc/profile.d/nexus-env.sh 2>/dev/null || true
set -x
set_git_identity() {
  git config --system user.name "$1" || true
  git config --system user.email "$2" || true
  echo "[nexux] commits will be authored as: $1 <$2>"
}
GIT_ID_SET=""
${primaryIsGitLab ? gitlabIdentity : githubIdentity}
${primaryIsGitLab ? githubIdentity : gitlabIdentity}
[ -n "\$GIT_ID_SET" ] || echo "[nexux] WARN: could not resolve the token owner — commits stay as Nexus Agent"`);

  if (spec.installAgentBrowser) {
    // agent-browser drives a real browser — without Chromium + its system
    // libs it can't render the app, so screenshots would be impossible.
    sections.push(`echo "[nexux] installing agent-browser + headless Chromium"
npm install -g agent-browser || echo "[nexux] WARN: agent-browser install failed"
# Install into a shared path so the agent user (not just root) can use it.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# --with-deps is an apt install in disguise; wait for the lock like the rest.
nexus_dpkg_wait
npx --yes playwright install --with-deps chromium || echo "[nexux] WARN: chromium install failed"
chmod -R a+rX /opt/ms-playwright 2>/dev/null || true
# agent-browser ignores PLAYWRIGHT_BROWSERS_PATH (it only checks its own
# cache, system Chrome locations and ~/.cache/ms-playwright), so expose the
# Playwright build as a "system Chrome" — otherwise agents find no browser
# and burn their run trying to download one.
# chrome-linux* matches both layouts: Playwright renamed the directory to
# chrome-linux64, and a glob pinned to the old name silently found nothing —
# the install succeeded, no WARN fired for it, and the only symptom was agents
# reporting no browser on a box that had one.
CHROME_BIN=$(ls -d /opt/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  ln -sf "$CHROME_BIN" /usr/local/bin/google-chrome
  echo "[nexux] chrome linked: $CHROME_BIN"
else
  # Name what is actually there, so the next rename is one log line to diagnose
  # rather than an ssh session.
  echo "[nexux] WARN: no chromium binary found to link (under /opt/ms-playwright: $(ls /opt/ms-playwright 2>/dev/null | tr '\\n' ' '))"
fi`);
  }

  // Custom setup runs *before* the repos, because what it installs is what the
  // repos are about to need. It used to run last, so a script installing Go,
  // k3d or helm did so long after `go mod download` and `make build` had
  // already failed with "command not found" — eight repos reporting install and
  // build failures on a box that ended up holding every tool they wanted.
  //
  // The trade is that a setup script cannot assume a checkout exists; anything
  // operating on the repos belongs in that repo's own install/build command,
  // which runs in the right place by construction.
  if (spec.setupScript?.trim()) {
    sections.push(`echo "[nexux] running custom setup script"
${spec.setupScript.trim()}`);
  }

  const repos = spec.repos.filter((r) => r.repoUrl || r.mountPath);
  if (repos.length > 0) {
    sections.push(renderRepoSetup(repos));
  }

  // Stack launchers: repo-owned commands that bring up their own containers.
  // They need the checkout in place *and* whatever the setup script installed,
  // so they run after both. Failures are logged, never fatal — a sandbox
  // without its side services is still worth having.
  const launchers = spec.stackLaunchers ?? [];
  if (launchers.length > 0) {
    sections.push(
      launchers
        .map((l) => {
          const dir = l.workdir
            ? `/opt/nexus/${l.repoDir}/${l.workdir}`
            : `/opt/nexus/${l.repoDir}`;
          // As the agent user: a launcher writes into the checkout it runs from
          // (emulator state, generated lib/, debug logs) and running it as root
          // leaves those root-owned — which is what later breaks the dev server
          // and the agent. AGENT_USER is in the docker group, so a
          // `docker compose up` still works.
          return `if [ -d "${dir}" ]; then
  echo "[nexux] stack launcher: ${l.name}"
  ${asAgent(dir, l.startCommand)} || echo "[nexux] WARN: launcher ${l.name} failed"
else
  echo "[nexux] WARN: launcher ${l.name} skipped — ${dir} not found"
fi`;
        })
        .join("\n"),
    );
  }

  // The `nexus` CLI and its manifest. After the repos and launchers, so the
  // banner's project list describes checkouts that actually exist. It used to
  // land before the custom setup script so that script could call `nexus`;
  // setup now runs first (it installs what the repos need), so it cannot — the
  // manifest it would have read describes checkouts that do not exist yet
  // anyway.
  //
  // The manifest here is spec-derived (repo runCommands only) — the host
  // overwrites it with the canvas-resolved plans via pushNexusCli() as soon as
  // the sandbox is reachable. `nexus info` prints the write date so a manifest
  // that never got that upgrade is still visibly dated rather than silently
  // wrong.
  sections.push(
    renderNexusCliSection(
      manifestFromSpec(spec, { generatedAt: opts.generatedAt ?? "" }),
    ),
  );

  // The session itself is started on demand (the user opening the Browser tab),
  // not here: a browser idling on every sandbox would cost memory on instances
  // nobody is looking at. Chromium already arrived with installAgentBrowser.
  if (spec.installBrowserSession) {
    sections.push(renderBrowserInstallSection());
  }

  // The completion marker is what the host polls to call a sandbox ready, so a
  // run that hit a fatal step must not leave it behind — the failure marker
  // carries the reason instead, and the host reports that rather than a
  // twenty-minute timeout with nothing in it.
  sections.push(`mkdir -p /opt/nexus
if [ -f ${BOOTSTRAP_FAILED_MARKER} ]; then
  echo "[nexux] bootstrap FAILED $(date -Is): $(cat ${BOOTSTRAP_FAILED_MARKER})"
else
  touch ${BOOTSTRAP_COMPLETE_MARKER}
  echo "[nexux] bootstrap finished $(date -Is)"
fi`);

  return sections.join("\n\n") + "\n";
}

export function renderTfVars(spec: SandboxSpec): string {
  return (
    JSON.stringify(
      {
        instance_name: spec.name,
        region: spec.region,
        size: spec.size,
        disk_image: spec.diskImage,
        ssh_public_key: spec.sshPublicKey?.trim() ?? "",
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Clone the project's repos, install them, and write the workspace file.
 *
 * Exported because the bootstrap is not the only thing that runs it: a setup
 * that failed for a reason since fixed — most often a git host that was not
 * reachable yet — is retried from the UI with exactly this script. Sharing one
 * renderer is the point; a second copy would be the one that drifts.
 *
 * Safe to re-run: `renderRepoSection` adopts an existing checkout rather than
 * re-cloning it, so a retry never destroys work already on the machine.
 */
export function renderRepoSetup(repos: SandboxRepoSpec[]): string {
  return `mkdir -p /opt/nexus
# The trace is off from here: \`set -x\` expands a token into the command line
# it echoes, which would land the credential verbatim in
# /var/log/nexus-bootstrap.log (readable by the UI's bootstrap-log route).
#
# It has to go off BEFORE the source below, not after it: xtrace traces every
# \`export\` inside the file, so sourcing it under trace dumps every project
# secret — tokens, API keys, whatever the project defines — into that log.
set +x
# Load project env vars for cloning and install/build commands.
[ -f /etc/profile.d/nexus-env.sh ] && . /etc/profile.d/nexus-env.sh
# Project-wide git tokens enable private clones per host. --system
# (/etc/gitconfig) is deliberate: it needs no $HOME and applies to every
# user on the instance.
#
# Each host is mapped from all THREE remote forms, not just https://. A sandbox
# has no ssh key for any git host, so an scp-style remote
# (git@host:group/repo.git) — which is what a GitLab or GitHub "clone with SSH"
# button hands you, and what submodules and pasted commands routinely carry —
# authenticates as nobody and dies with "Permission denied (publickey)". That
# error names ssh rather than the missing rewrite, so it reads as a key problem
# on a box that was never going to have a key. Rewriting to the token URL is
# what makes the form the user actually pasted work.
nexus_git_auth() {
  # \$1 host, \$2 userinfo (user:token). --replace-all on the first so a
  # re-bootstrap resets the list instead of appending a fourth duplicate.
  git config --system --replace-all url."https://\$2@\$1/".insteadOf "https://\$1/" &&
  git config --system --add url."https://\$2@\$1/".insteadOf "git@\$1:" &&
  git config --system --add url."https://\$2@\$1/".insteadOf "ssh://git@\$1/"
}
if [ -n "\${GITHUB_TOKEN:-}" ]; then
  echo "[nexux] configuring git auth for github.com"
  nexus_git_auth github.com "x-access-token:\${GITHUB_TOKEN}" || echo "[nexux] WARN: git auth config failed"
fi
if [ -n "\${GITLAB_TOKEN:-}" ]; then
  echo "[nexux] configuring git auth for gitlab.com"
  nexus_git_auth gitlab.com "oauth2:\${GITLAB_TOKEN}" || echo "[nexux] WARN: git auth config failed"
fi
# Self-hosted GitLab: GITLAB_HOST (glab's own convention) extends token auth
# to that instance too. Tolerates a scheme in the value (https://host → host).
if [ -n "\${GITLAB_TOKEN:-}" ] && [ -n "\${GITLAB_HOST:-}" ]; then
  GL_HOST="\${GITLAB_HOST#https://}"; GL_HOST="\${GL_HOST#http://}"; GL_HOST="\${GL_HOST%%/*}"
  if [ "\$GL_HOST" != "gitlab.com" ] && [ -n "\$GL_HOST" ]; then
    echo "[nexux] configuring git auth for \$GL_HOST"
    nexus_git_auth "\$GL_HOST" "oauth2:\${GITLAB_TOKEN}" || echo "[nexux] WARN: git auth config failed"
  fi
fi
if [ -n "\${BITBUCKET_TOKEN:-}" ]; then
  echo "[nexux] configuring git auth for bitbucket.org"
  nexus_git_auth bitbucket.org "x-token-auth:\${BITBUCKET_TOKEN}" || echo "[nexux] WARN: git auth config failed"
fi
unset -f nexus_git_auth
set -x
${repos.map(renderRepoSection).join("\n")}
${writeCodeWorkspaceCommand(repos.map((r) => ({ name: r.name })))}
# Belt and braces: the clone/install/build above already ran as the agent user,
# so this should be a no-op. It stays for anything root touched on the way —
# a mounted checkout, or a repo whose install command escalates on its own.
chown -R ${AGENT_USER}:${AGENT_USER} /opt/nexus
`;
}
