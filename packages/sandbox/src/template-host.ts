/**
 * Bootstrap for a **Nexus host** — the 24/7 VM that runs Nexus itself.
 * Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * Contrast with `template.ts`, which bootstraps a *sandbox*: that one clones
 * repos, installs agent CLIs and runs tasks. This one installs Docker and
 * Tailscale, pulls a published image, and brings up the compose stack. The
 * Terraform module (`renderMainTf`) is shared — provisioning a VM is the same
 * problem either way; what differs is what the VM becomes.
 *
 * Two invariants shape the whole file:
 *
 * 1. **The app has no authentication** (D-34). The host must therefore bind to
 *    its Tailscale address, never `0.0.0.0`. The bootstrap reads that address
 *    back from `tailscale ip -4` and refuses to start the stack without it —
 *    a box that came up bound to a public interface would be worse than one
 *    that failed.
 * 2. **The auth key is a secret on a machine we are writing a log on.** It is
 *    never echoed: `set -x` is disabled around the `tailscale up` call, and the
 *    key reaches the process through a file that is deleted immediately.
 */

import { shq } from "./slug";

/** Where the host keeps its compose file, env and marker. */
export const HOST_DIR = "/opt/nexus-host";
export const HOST_BOOTSTRAP_LOG = "/var/log/nexus-host-bootstrap.log";
/** Written last; the panel polls for it rather than guessing from uptime. */
export const HOST_MARKER = `${HOST_DIR}/.bootstrap-complete`;

/**
 * Where the app asks its own machine to update it.
 *
 * The container deliberately has no docker socket (D-34: mounting it is
 * root-equivalent on the host), so the app cannot pull its own image. It writes
 * a request into this bind-mounted directory instead, and a systemd path unit
 * running as root does the pull. The socket stays out of the container and the
 * only thing it can ask for is "run the updater" — it cannot pass a command.
 */
export const HOST_CONTROL_DIR = `${HOST_DIR}/control`;

/**
 * Where checkouts live *inside* the container.
 *
 * A host has no bind-mounted source tree: the image is pulled, and everything
 * outside a declared volume belongs to the image layer — root-owned, and thrown
 * away the next time `up -d` recreates the container. Cloning into a path the
 * app made up (`/opt/workspace`) therefore failed twice over: `EACCES` because
 * uid 1001 cannot write under root-owned `/opt`, and, had it been writable, a
 * checkout that would not survive the next update.
 *
 * So the host declares one named volume for them and tells the app where it is.
 * `nexux` owns it (the Dockerfile creates the mountpoint chowned, which docker
 * copies onto a fresh volume), so no chown runs on the host side.
 */
export const HOST_WORKSPACE_DIR = "/workspace";
/** Touched by the app to request an update; consumed by the systemd unit. */
export const HOST_UPDATE_REQUEST = `${HOST_CONTROL_DIR}/update-requested`;
/** The updater's own log, so the UI can show what the pull did. */
export const HOST_UPDATE_LOG = `${HOST_CONTROL_DIR}/update.log`;

/**
 * The account a provider's image lets you SSH in as before the bootstrap has
 * run. Ubuntu AMIs on AWS pre-seed /root/.ssh/authorized_keys with a
 * `command="Please login as the user \"ubuntu\"..."` entry, so connecting as
 * root fails until the bootstrap overwrites it — and the monitor connects
 * *while* cloud-init is still running.
 */
export function initialSshUser(provider: "civo" | "aws"): string {
  return provider === "aws" ? "ubuntu" : "root";
}

/**
 * The registry `docker login` should target, derived from an image reference.
 *
 * A reference with no registry component (`nexus:tag`) is Docker Hub, whose
 * canonical login host is docker.io — `docker login nexus` would try to reach a
 * host by that name.
 */
export function registryHost(imageRef: string): string {
  const slash = imageRef.indexOf("/");
  // With no slash there is no registry component at all: `nexus:edge` is a
  // Docker Hub image whose colon introduces the *tag*, not a port.
  if (slash === -1) return "docker.io";
  const first = imageRef.slice(0, slash);
  // A registry component always has a dot (ghcr.io) or a port (localhost:5000);
  // anything else is a Docker Hub namespace, as in `library/nexus`.
  return first.includes(".") || first.includes(":") ? first : "docker.io";
}

export type NexusHostSpec = {
  /** Instance hostname; also the Tailscale machine name. */
  name: string;
  /** SSH keys authorized for root, so the monitor can read bootstrap state. */
  authorizedKeys?: string[];
  /** Full image reference, e.g. ghcr.io/ideascoldigital/nexus:latest. */
  imageRef: string;
  /** Tailscale auth key — ephemeral, pre-authorized, reusable. */
  tailscaleAuthKey: string;
  /**
   * Coordination server to join, for a self-hosted control plane (Headscale) —
   * `--login-server`. Absent means Tailscale's own. A host still requires a
   * key either way: its bootstrap is unattended and fatal on a failed join, so
   * it has nobody to approve an interactive registration.
   */
  tailscaleLoginServer?: string | null;
  /** Pull nomic-embed-text after the stack is up. The slowest step. */
  pullEmbeddingModel: boolean;
  /**
   * Optional registry credentials, for a private GHCR package. Omit when the
   * package is public — which is the recommended setup, since this writes a
   * token onto the instance.
   */
  registry?: { username: string; password: string } | null;
  /** Extra bash appended at the very end, before the marker. */
  setupScript?: string | null;
};

/**
 * A hostname the provider and Tailscale both accept: lowercase alphanumerics
 * and hyphens, no leading/trailing hyphen, capped at 63 characters (DNS label
 * limit — Tailscale's MagicDNS name is derived from it).
 */
export function safeHostName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return cleaned || "nexus-host";
}

/**
 * Reject an image reference that could break out of the shell or point
 * somewhere unintended. Deliberately strict: this string is interpolated into
 * `docker pull`, and the set of characters a real reference needs is small.
 *
 * Accepts `[registry[:port]/]name[:tag|@sha256:digest]`.
 */
export function isValidImageRef(ref: string): boolean {
  if (!ref || ref.length > 255) return false;
  if (/\s/.test(ref)) return false;
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(
    ref,
  );
}

/**
 * The compose file written onto the host.
 *
 * Generated rather than fetched from the repo: a host created today must not
 * change behaviour because `docker-compose.yml` was edited tomorrow. It mirrors
 * that file's shape, minus the `build:` block — the image is pulled.
 */
export function renderHostCompose(spec: {
  imageRef: string;
  tailscaleIpVar?: string;
}): string {
  // The bind address is substituted by the bootstrap from the resolved
  // Tailscale IP, through the .env file compose reads.
  return `# Generated by Nexus for this host — edits are overwritten on re-bootstrap.
#
# Ports bind to NEXUX_BIND (this machine's Tailscale address), never 0.0.0.0:
# the app has no authentication of any kind.
services:
  nexux:
    image: ${spec.imageRef}
    ports:
      - "\${NEXUX_BIND}:3030:3030"
      - "\${NEXUX_BIND}:3002:3002"
    environment:
      PORT: "3030"
      DATABASE_URL: "file:/data/dashboard.db"
      NEXUX_MIGRATIONS_DIR: "/app/prisma/migrations"
      NEXUX_DATA_DIR: "/data"
      OLLAMA_URL: "http://ollama:11434"
      NEXUX_TERMINAL_PORT: "3002"
      NEXUX_WEB_ORIGIN: "\${NEXUX_WEB_ORIGIN}"
      # Tells the app it *is* a host, so it hides the "create a host" panel.
      NEXUX_ROLE: "host"
      # Where cloned repositories belong. Without this the app has no writable
      # place to check anything out — see HOST_WORKSPACE_DIR.
      NEXUX_WORKSPACE_ROOT: "${HOST_WORKSPACE_DIR}"
    env_file:
      - path: .env
        required: false
    volumes:
      - nexux-data:/data
      # Cloned repositories. A named volume rather than an image path: the
      # container is recreated on every update, and a checkout in the image
      # layer would be discarded with it.
      - nexux-workspace:${HOST_WORKSPACE_DIR}
      # How the app asks to be updated. A directory, not the docker socket:
      # the socket is root-equivalent on the host, and all the app needs is to
      # leave a note that a root-side systemd unit acts on.
      - ${HOST_CONTROL_DIR}:/host-control
    depends_on:
      - ollama
    restart: unless-stopped

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama-models:/root/.ollama
    # Never published: an unauthenticated model API.
    expose:
      - "11434"
    restart: unless-stopped

volumes:
  nexux-data:
  nexux-workspace:
  ollama-models:
`;
}

/**
 * The cloud-init script.
 *
 * `set -u` but deliberately **not** `set -e`, matching `renderCloudInit`:
 * cloud-init runs this unattended, and aborting on the first non-zero exit
 * (which includes benign cases like a re-run `mv`) would leave a half-built box
 * with no marker and no useful log. Failures that matter are checked
 * explicitly.
 */
export function renderHostCloudInit(
  spec: NexusHostSpec,
  opts: { generatedAt?: string } = {},
): string {
  const name = safeHostName(spec.name);
  if (!isValidImageRef(spec.imageRef)) {
    throw new Error(
      `Refusing to render a bootstrap for an invalid image reference: ${spec.imageRef}`,
    );
  }

  const stamp = opts.generatedAt ?? "";
  const compose = renderHostCompose({ imageRef: spec.imageRef });
  // Only emitted for a self-hosted control plane; Tailscale's own is the
  // default and passing it explicitly would just be noise.
  const loginServer = spec.tailscaleLoginServer?.trim().replace(/\/+$/, "");
  const loginServerFlag = loginServer
    ? `\n  --login-server=${shq(loginServer)} \\`
    : "";

  const sections: string[] = [];

  sections.push(`#!/bin/bash
# Nexus host bootstrap — generated for "${name}"${stamp ? ` at ${stamp}` : ""}.
#
# Turns a bare cloud instance into a Nexus host: Docker, Tailscale, then the
# app itself pulled from a registry and bound to the tailnet address.
exec > >(tee -a ${HOST_BOOTSTRAP_LOG}) 2>&1
set -ux
export DEBIAN_FRONTEND=noninteractive
export HOME="\${HOME:-/root}"

echo "[nexus-host] bootstrap started $(date -Is)"

mkdir -p ${HOST_DIR}
cd ${HOST_DIR}

apt-get update -y
apt-get install -y ca-certificates curl gnupg`);

  // Providers install the terraform-registered key for their own initial user
  // ("ubuntu" on AWS Ubuntu AMIs, "civo" on Civo), not root. Re-authorize the
  // keys for root so the host can be administered the same way everywhere.
  //
  // OVERWRITE rather than append: Ubuntu AMIs pre-seed
  // /root/.ssh/authorized_keys with a `command="Please login as the user
  // \"ubuntu\""` entry for the *same* key, and sshd uses the first matching
  // entry — an appended clean copy is never reached. Same reasoning as
  // template.ts.
  const authorizedKeys = (spec.authorizedKeys ?? [])
    .map((k) => k.trim())
    .filter(Boolean);
  if (authorizedKeys.length > 0) {
    sections.push(`
echo "[nexus-host] authorizing SSH keys for root"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat > /root/.ssh/authorized_keys <<'NEXUS_KEYS_EOF'
${authorizedKeys.join("\n")}
NEXUS_KEYS_EOF
chmod 600 /root/.ssh/authorized_keys`);
  }

  // ---- Docker -------------------------------------------------------------
  sections.push(`
echo "[nexus-host] installing docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \\
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \${VERSION_CODENAME} stable" \\
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# Wait for the daemon: compose commands below fail confusingly without it.
for i in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done
docker info >/dev/null 2>&1 || echo "[nexus-host] WARN: dockerd did not come up"`);

  // ---- Tailscale ----------------------------------------------------------
  // The auth key must not reach the log. `set +x` around the call, and the key
  // travels via a 0600 file that is removed straight after.
  sections.push(`
echo "[nexus-host] installing tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled

# The auth key is a secret and this script is tee'd to a log — never let it be
# traced or written anywhere durable.
set +x
umask 077
printf '%s' ${shq(spec.tailscaleAuthKey)} > ${HOST_DIR}/.tskey
tailscale up \\
  --authkey="$(cat ${HOST_DIR}/.tskey)" \\${loginServerFlag}
  --hostname=${shq(name)} \\
  --ssh \\
  --accept-dns=false
ts_rc=$?
rm -f ${HOST_DIR}/.tskey
set -x
umask 022

if [ "$ts_rc" -ne 0 ]; then
  echo "[nexus-host] FATAL: tailscale up failed (rc=$ts_rc)"
  echo "[nexus-host] the key must be ephemeral, pre-authorized and reusable"
  exit 1
fi

# The address the app binds to. Everything below depends on it.
TS_IP=""
for i in $(seq 1 30); do
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "$TS_IP" ] && break
  sleep 2
done

if [ -z "$TS_IP" ]; then
  echo "[nexus-host] FATAL: no tailscale IPv4 address after 60s"
  # Deliberately fatal: binding to 0.0.0.0 instead would expose an app with no
  # authentication to the public internet (D-34).
  exit 1
fi
echo "[nexus-host] tailscale address: $TS_IP"`);

  // ---- Compose stack ------------------------------------------------------
  sections.push(`
echo "[nexus-host] writing compose stack"
cat > ${HOST_DIR}/docker-compose.yml <<'NEXUS_COMPOSE_EOF'
${compose}NEXUS_COMPOSE_EOF

# Written fresh each run so a re-bootstrap re-resolves the address (Tailscale
# can hand out a different one after the machine is removed and re-added).
cat > ${HOST_DIR}/.env <<NEXUS_ENV_EOF
NEXUX_BIND=$TS_IP
NEXUX_WEB_ORIGIN=http://$TS_IP:3030
NEXUS_ENV_EOF${
    spec.registry
      ? `
# The same GitHub token the registry login below writes to this machine, also
# handed to the app (compose env_file) so its update check can see releases on
# a private repo. Appended outside the heredoc so it is never shell-expanded.
set +x
printf 'GITHUB_TOKEN=%s\\n' ${shq(spec.registry.password)} >> ${HOST_DIR}/.env
set -x`
      : ""
  }
chmod 600 ${HOST_DIR}/.env`);

  // ---- Self-update ---------------------------------------------------------
  // The app is the thing being restarted, so it cannot run the restart: the
  // moment `up -d` recreates the container, whatever process issued the command
  // is killed mid-pull. A systemd unit owns it instead — it survives the
  // container it replaces, and it is the only thing here with docker access.
  sections.push(`
echo "[nexus-host] installing the self-update helper"
mkdir -p ${HOST_CONTROL_DIR}
# The app writes as its own uid; the directory is bind-mounted into it.
chmod 777 ${HOST_CONTROL_DIR}

cat > ${HOST_DIR}/update.sh <<'NEXUS_UPDATE_EOF'
#!/bin/bash
# Pull the published image and recreate the stack. Generated by Nexus.
#
# Deliberately NOT \`down\` then \`up\`: the named volumes carry the database,
# the credentials and the search indexes, and \`down -v\` would take them with
# it. \`up -d\` recreates only the containers whose image changed.
set -u
exec >> ${HOST_UPDATE_LOG} 2>&1
# Consumed first: the path unit triggers on this file existing, so leaving it
# in place would re-fire the unit for as long as it is there.
rm -f ${HOST_UPDATE_REQUEST}
echo "[nexus-update] started $(date -Is)"
cd ${HOST_DIR} || exit 1

# Every update leaves the superseded image behind, and nothing else on the host
# collects them: left alone they fill the disk and the *next* pull dies half way
# through extracting a layer. Dangling images only — anything a running
# container still references is kept, and named volumes (database, credentials,
# search indexes) are never candidates for this.
echo "[nexus-update] reclaiming space from superseded images"
docker image prune -f

if ! docker compose pull; then
  # A pull fails for two very different reasons and the log is all the operator
  # gets, so name the one that actually happened rather than guessing.
  if [ "$(df --output=avail ${HOST_DIR} | tail -1)" -lt 2097152 ]; then
    echo "[nexus-update] FAILED: the disk is full — less than 2GB free on ${HOST_DIR}"
    df -h ${HOST_DIR}
    echo "[nexus-update] free space, then update again: docker image prune -af"
  else
    echo "[nexus-update] FAILED: could not pull — check the registry credentials"
  fi
  echo "[nexus-update] finished $(date -Is)"
  exit 1
fi

# Recreating the web container kills this script's parent if it were run from
# inside it; systemd is what makes that safe.
docker compose up -d
echo "[nexus-update] running: $(docker compose images --quiet nexux 2>/dev/null | head -1)"
echo "[nexus-update] finished $(date -Is)"
NEXUS_UPDATE_EOF
chmod 755 ${HOST_DIR}/update.sh

cat > /etc/systemd/system/nexus-update.service <<'NEXUS_UPDATE_SERVICE_EOF'
[Unit]
Description=Update the Nexus host stack
[Service]
Type=oneshot
ExecStart=${HOST_DIR}/update.sh
NEXUS_UPDATE_SERVICE_EOF

# A path unit rather than a timer: an update should start when it is asked for,
# not up to a minute later.
cat > /etc/systemd/system/nexus-update.path <<'NEXUS_UPDATE_PATH_EOF'
[Unit]
Description=Watch for a Nexus update request
[Path]
PathExists=${HOST_UPDATE_REQUEST}
[Install]
WantedBy=multi-user.target
NEXUS_UPDATE_PATH_EOF

# A request left over from before a reboot would fire the moment the unit is
# armed, updating a host nobody asked to update.
rm -f ${HOST_UPDATE_REQUEST}
systemctl daemon-reload
systemctl enable --now nexus-update.path`);

  if (spec.registry) {
    sections.push(`
echo "[nexus-host] authenticating to ${registryHost(spec.imageRef)}"
set +x
printf '%s' ${shq(spec.registry.password)} \\
  | docker login ${shq(registryHost(spec.imageRef))} \\
      --username ${shq(spec.registry.username)} --password-stdin \\
  || echo "[nexus-host] WARN: registry login failed — the pull below will say why"
set -x`);
  }

  sections.push(`
echo "[nexus-host] pulling ${spec.imageRef}"
if ! docker compose -f ${HOST_DIR}/docker-compose.yml pull; then
  echo "[nexus-host] FATAL: could not pull ${spec.imageRef}"
  # On a freshly provisioned disk this means the volume is too small for the
  # image, not that anything is wrong with the credentials — a distinction the
  # operator cannot make from the compose output alone.
  if [ "$(df --output=avail ${HOST_DIR} | tail -1)" -lt 2097152 ]; then
    echo "[nexus-host] the disk is full — this host's volume is too small for the image"
    df -h ${HOST_DIR}
  else
    echo "[nexus-host] is the package public, or does this host need registry credentials?"
  fi
  exit 1
fi

echo "[nexus-host] starting the stack"
docker compose -f ${HOST_DIR}/docker-compose.yml up -d

# Readiness is the health route answering, not the container existing:
# migrations run on the first database connection.
ready=""
for i in $(seq 1 60); do
  if curl -fsS -m 5 "http://$TS_IP:3030/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 5
done

if [ -z "$ready" ]; then
  echo "[nexus-host] WARN: the app did not answer /api/health within 5 minutes"
  docker compose -f ${HOST_DIR}/docker-compose.yml logs --tail 50 nexux
fi`);

  if (spec.pullEmbeddingModel) {
    sections.push(`
# Semantic search and the ⌘K palette need this model. Slow (~270MB), and the
# stack is already usable without it, so a failure here is not fatal.
echo "[nexus-host] pulling the embedding model"
docker compose -f ${HOST_DIR}/docker-compose.yml exec -T ollama \\
  ollama pull nomic-embed-text \\
  || echo "[nexus-host] WARN: could not pull nomic-embed-text — search will be empty until it is"`);
  }

  if (spec.setupScript?.trim()) {
    sections.push(`
echo "[nexus-host] running custom setup script"
${spec.setupScript.trim()}`);
  }

  // The marker records the resolved address, so the panel learns where the
  // host actually lives by reading one file rather than shelling twice.
  sections.push(`
echo "[nexus-host] bootstrap finished $(date -Is)"
printf 'tailscale_ip=%s\\n' "$TS_IP" > ${HOST_MARKER}
printf 'image=%s\\n' ${shq(spec.imageRef)} >> ${HOST_MARKER}
echo "[nexus-host] reach it at http://$TS_IP:3030"`);

  return sections.join("\n") + "\n";
}

/**
 * Parse the completion marker written above. Returns null when the bootstrap
 * has not finished — the caller keeps polling rather than assuming failure.
 */
export function parseHostMarker(
  contents: string,
): { tailscaleIp: string; imageRef: string | null } | null {
  const ip = contents.match(/^tailscale_ip=(.+)$/m)?.[1]?.trim();
  if (!ip) return null;
  const image = contents.match(/^image=(.+)$/m)?.[1]?.trim() ?? null;
  return { tailscaleIp: ip, imageRef: image };
}
