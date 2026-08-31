# syntax=docker/dockerfile:1

# ---- Nexux server image (container deploy) ----------------------------------
# Runs the same Next.js app that the Tauri desktop build wraps as a sidecar,
# but standalone — no Tauri, no bundled node binary. Native deps (better-sqlite3,
# @lancedb, node-pty, prisma) are compiled/traced FOR LINUX inside this image;
# never copy the macOS build output in. Embeddings call out to Ollama over the
# network via OLLAMA_URL, so Ollama is NOT bundled here — docker-compose.yml
# runs it as a sibling service.
#
# The image assumes it sits on a TRUSTED NETWORK. The app has no authentication
# of any kind: every /api route is open, `/env-vars/[id]/reveal` returns stored
# secrets in plaintext, and the terminal WS execs into sandboxes. Deploy it
# behind Tailscale (or an equivalent private network) and publish NO ports to
# the public internet — see docs/DEPLOYMENT.md.
# ----------------------------------------------------------------------------

ARG NODE_VERSION=20

# ---- Stage 1: build --------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Toolchain for native module compilation (better-sqlite3, etc.).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /repo

# Install with full dev deps (build needs them). Copy manifests first for cache.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
# apps/native is deliberately absent: this image is the standalone server, and
# nothing here imports the Tauri shell. Its manifest would only drag in
# @tauri-apps/cli (~100MB of per-platform binaries) that never ship.
# `pnpm install` is scoped below so the missing workspace member is not an
# error. (NEXUX_BUILD_TARGET=native further down is unrelated to Tauri — it is
# the flag that turns on Next's `output: "standalone"`.)
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/embeddings/package.json packages/embeddings/
COPY packages/llm/package.json packages/llm/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/storage/package.json packages/storage/
COPY packages/terminal/package.json packages/terminal/
COPY packages/harness/package.json packages/harness/
# Manifests alone are not enough for a package with a `postinstall`: pnpm runs
# it during the install below, long before `COPY . .`. @nexux/terminal's makes
# node-pty's `spawn-helper` executable (the prebuilt tarball loses the bit, and
# a non-executable helper kills every pty with EACCES), so its script has to be
# here or the install fails with MODULE_NOT_FOUND. Any new lifecycle script in a
# workspace package needs the same treatment.
COPY packages/terminal/scripts/ packages/terminal/scripts/
# Scoped to @nexux/web and its workspace deps: without the filter, pnpm expects
# every member the lockfile knows about (including apps/native, absent above)
# and --frozen-lockfile fails.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @nexux/web...

# Bring in the rest of the source.
COPY . .

# Standalone output (output: "standalone" is gated on NEXUX_BUILD_TARGET=native
# in next.config.ts) + prisma client for linux. DATABASE_URL is only needed to
# satisfy prisma's config loader at generate/build time — the real value is set
# in the runtime stage and points at the volume.
ENV NEXUX_BUILD_TARGET=native
ENV DATABASE_URL="file:/tmp/build.db"
# Headroom for the webpack build worker (default heap OOMs → "Call retries
# were exceeded").
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm --filter @nexux/db generate
# Match the desktop sidecar build: webpack (next.config.ts has a webpack hook,
# and Next 16 otherwise errors on the ambiguity).
RUN pnpm --filter @nexux/web exec next build --webpack

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=3030
ENV HOSTNAME=0.0.0.0
# SQLite DB lives on a writable volume, not in the image layer.
ENV DATABASE_URL="file:/data/dashboard.db"
# Migrations are applied at first DB connection (packages/db/src/client.ts);
# the app only migrates when this points at the bundled migrations dir.
ENV NEXUX_MIGRATIONS_DIR=/app/prisma/migrations
# Everything else the app keeps on disk — LanceDB indexes (<dataDir>/indexes)
# and the installation's sandbox SSH keypair (<dataDir>/ssh, keys.ts) — resolves
# from here. WITHOUT this it defaults to the nexux user's home, which is an
# image layer: every `docker compose up --build` would silently drop the search
# indexes AND regenerate the SSH key, locking the install out of every sandbox
# it had already provisioned.
ENV NEXUX_DATA_DIR=/data
# Embeddings reach Ollama over the network. The compose file points this at the
# bundled ollama service; host.docker.internal only resolves on Docker Desktop
# or with an explicit host-gateway mapping.
ENV OLLAMA_URL=http://host.docker.internal:11434
# The human terminal (@nexux/terminal) boots in-process from instrumentation.ts
# and serves WS on its own port. Publish it alongside 3030 or "Open terminal"
# has nothing to connect to.
ENV NEXUX_TERMINAL_PORT=3002
# Shell for those terminal sessions. Docker sets no $SHELL, and the config
# fallback chain would land on /bin/sh; bookworm-slim ships bash, so be
# explicit and give sessions a proper login shell.
ENV SHELL=/bin/bash
# Belt to the `ws` externalization in next.config.ts: never let ws pick up a
# bufferutil native addon (none is shipped), always its pure-JS fallback. A
# bundler regression here previously killed the terminal WS on every ≥32-byte
# frame with "b.unmask is not a function".
ENV WS_NO_BUFFER_UTIL=1

WORKDIR /app

# Runtime tools the app shells out to. Provisioning a cloud sandbox runs
# `terraform` (terraform.ts) and then reaches it over `ssh`/`scp` (remote.ts);
# repo setup runs `git`. Without these the Sandboxes tab fails at launch time
# rather than at startup, which is the worse place to find out.
# NOTE: the local (docker-in-docker) sandbox provider is deliberately NOT
# supported in this image — it would need the host's docker socket mounted,
# which is root-equivalent on the host. Cloud providers only here.
ARG TERRAFORM_VERSION=1.9.8
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates curl unzip git openssh-client \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
       amd64) tf_arch=amd64 ;; \
       arm64) tf_arch=arm64 ;; \
       *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/terraform.zip \
       "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tf_arch}.zip" \
  && unzip -q /tmp/terraform.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/terraform \
  && rm /tmp/terraform.zip \
  && apt-get purge -y unzip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Non-root user owns the app, the data dir and the workspace.
#
# /workspace is where a host checks repositories out. It is created here, empty
# and chowned, precisely so the named volume mounted over it inherits that
# ownership: docker seeds a fresh volume from the image directory, permissions
# included. Without the mountpoint the volume would come up root-owned and every
# clone would fail with EACCES, which is the bug this exists to prevent.
# --create-home matters: ssh, git and most CLIs resolve paths under $HOME
# (known_hosts, config) and error out — some fatally — when the directory in
# /etc/passwd does not exist, which is what a bare `useradd --system` leaves.
RUN groupadd --system --gid 1001 nexux \
  && useradd --system --uid 1001 --gid nexux --create-home --shell /bin/bash nexux \
  && mkdir -p /data /workspace \
  && chown -R nexux:nexux /data /workspace

# Standalone bundle = server + traced node_modules (sqlite/lance/prisma/ollama).
# Layout mirrors the monorepo: server.js is under apps/web/.
COPY --from=builder --chown=nexux:nexux /repo/apps/web/.next/standalone ./
COPY --from=builder --chown=nexux:nexux /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nexux:nexux /repo/apps/web/public ./apps/web/public
# Prisma migrations, applied at startup against the sqlite volume.
COPY --from=builder --chown=nexux:nexux /repo/packages/db/prisma/migrations ./prisma/migrations
COPY --from=builder --chown=nexux:nexux /repo/packages/db/prisma/schema.prisma ./prisma/schema.prisma

# Build identity, surfaced by /api/version so a host can say which build it is
# running (.dockerignore excludes .git, so the SHA must come in as an arg — CI
# passes it; a local build without it still gets the date stamp, which this
# layer records itself because it sits after the app COPYs and so re-runs
# whenever their content changed).
ARG NEXUX_GIT_SHA=""
ARG NEXUX_VERSION=""
ENV NEXUX_GIT_SHA=$NEXUX_GIT_SHA
ENV NEXUX_VERSION=$NEXUX_VERSION
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/.built-at

USER nexux
EXPOSE 3030 3002
VOLUME ["/data", "/workspace"]

# server.js is Next's standalone entry; it reads PORT/HOSTNAME from env.
CMD ["node", "apps/web/server.js"]
