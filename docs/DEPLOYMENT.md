# Nexux — Deploying to a VM (24/7 install)

Running the dashboard on a server you keep up, alongside (not instead of) the
local-first install on your laptop. Configuration moves between the two as a
JSON export — see [specs/18-config-export-import.md](../specs/18-config-export-import.md).

## Read this first: there is no authentication

Nexux is local-first (D-01) and assumes a single user on a trusted machine.
There is no login, no session, no middleware. Concretely, anyone who can reach
the port can:

- read every stored secret in plaintext (`GET /api/projects/<id>/env-vars/<id>/reveal`),
- provision cloud sandboxes with your saved Civo/AWS credentials — your card,
- open a terminal WebSocket that `exec`s into sandboxes,
- export the whole configuration, secrets included.

So the deployment rule is: **do not publish a port to the internet.** Put the
box on a private network and reach it through that. `docker-compose.yml` binds
to `127.0.0.1` by default so a careless `up` cannot expose anything.

If you ever do need public exposure, that is an authentication feature, not a
deployment setting — and it needs to cover the API routes *and* the terminal
WS, which does not share Next's request pipeline.

## What you need

- A VM with Docker and the compose plugin. 4 vCPU / 8 GB / 60 GB is comfortable
  with Ollama; 2 / 4 GB works if you pull a prebuilt image and skip embeddings.
- A [Tailscale](https://tailscale.com) account (free tier is enough).

### Build on the VM, or pull a published image?

**Pull, if you can.** Building needs ~6 GB of RAM
(`NODE_OPTIONS=--max-old-space-size=4096` plus the native toolchain) and about
ten minutes — so the VM has to be sized for a step it performs once.

`.github/workflows/release-image.yml` publishes the server image to
`ghcr.io/ideascoldigital/nexus`, **amd64 only** — the default on Civo, Hetzner
and EC2. arm64 is opt-in via a manual run: on an amd64 runner the arm64 leg
emulates under QEMU and takes 45+ minutes instead of ~1 on a native runner.
If you deploy to an arm VM, run the workflow manually and pick a platform list
that includes `linux/arm64`.

| Trigger | Tags produced |
|---|---|
| push to `main` | `edge`, `main-<sha>` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `latest` |
| manual run | the branch name; can build without pushing |

`latest` deliberately tracks **release tags, not `main`** — a host pulling
`:latest` should get a release, not whatever landed an hour ago. Until the
first `v*` tag is cut, **`latest` does not exist**; use `edge`.

To use it, replace the `build:` block in `docker-compose.yml` with:

```yaml
image: ghcr.io/ideascoldigital/nexus:edge
```

> GHCR packages are **private by default**. Either make the package public
> (Packages → nexus → Package settings → Change visibility) or give the VM a
> registry token — `docker login ghcr.io` with a PAT that has `read:packages`.
> A private package with no token fails at `docker pull`, which on a freshly
> provisioned VM looks like a Nexux bug rather than a permissions setting.

Building in place still works and is what the rest of this document assumes;
it needs no registry at all.

## 1. Private network

On the VM:

```bash
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
```

Note the address it reports (`tailscale ip -4` → `100.x.y.z`). That is the only
address the dashboard will listen on.

Leave the cloud firewall closed for 3030/3002. Tailscale needs no inbound
ports.

## 2. Configure

```bash
git clone <your-fork> nexux && cd nexux
cp .env.docker.example .env
```

Edit `.env`:

```bash
NEXUX_BIND=100.x.y.z
NEXUX_WEB_ORIGIN=http://100.x.y.z:3030
```

`NEXUX_WEB_ORIGIN` must match the URL you actually open. Two things read it and
neither can work it out on its own — the container binds to `0.0.0.0`, so the
server genuinely does not know how you reach it (D-53):

- the terminal server sends it as the CORS origin; a mismatch is a terminal
  that never connects while the rest of the app works.
- outward-facing URLs, above all the ClickUp OAuth `redirect_uri`; a mismatch
  is a "Connect" that dies on ClickUp's consent screen. Settings →
  Integrations → ClickUp shows the exact callback URL derived from this value —
  register *that* string on the ClickUp app, character for character.

## 3. Start

```bash
docker compose up -d --build
```

Then pull the embedding model once — the Ollama volume persists it:

```bash
docker compose exec ollama ollama pull nomic-embed-text
```

Check it:

```bash
curl -s http://100.x.y.z:3030/api/health
```

## 4. Move your configuration over

On the laptop: **Settings → Backup & migration → Download export**. Turn on
*Include secrets* (with a passphrase) if you want the keys to travel; otherwise
you will re-enter them on the VM.

On the VM's dashboard: same tab → choose the file → leave **Workspace root on
this machine** blank → **Preview changes** → **Apply**. Blank rebases the
laptop's paths (`/Users/...`, which does not exist here) onto `/workspace`, the
volume the host mounts for checkouts.

Only override it with a path that is writable *inside the container*. The app
runs as an unprivileged user and the container is recreated on every update, so
a path outside a declared volume either fails to clone with `EACCES` or loses
the checkout at the next update — `/opt/workspace` does both.

Two things the import deliberately does not do for you:

- **Schedules arrive disabled.** Enable them here only after disabling them on
  the laptop, or both installs run the same tasks — duplicate agents,
  duplicate PRs, double spend.
- **Repositories arrive `pending`.** The import moves configuration, not code.
  Press **Clone** on the project's Repositories panel to check them out.

If you moved the Telegram token, delete it from the laptop's Settings. The bot
long-polls as a singleton (D-08) and two pollers fight over updates.

## What this image can and cannot do

| | |
|---|---|
| Dashboard, projects, roadmap, Stack canvas | ✅ |
| Semantic search / ⌘K | ✅ via the bundled Ollama |
| Cloud sandboxes (Civo / AWS) | ✅ `terraform`, `ssh` and `git` are installed |
| Human terminal into a sandbox | ✅ port 3002 |
| **Local (docker-in-docker) sandboxes** | ❌ deliberate — see below |

Local sandboxes need the host's Docker socket mounted into the container, which
is root-equivalent on the host: anyone reaching the unauthenticated app would
control Docker. Not worth it for a provider whose entire purpose is a free
local alternative to a cloud VM. Keep using local sandboxes on your laptop and
cloud sandboxes here.

## Backups

Everything lives in the `nexux-data` volume: the SQLite database, the LanceDB
indexes, and the installation's sandbox SSH keypair.

```bash
docker run --rm -v nexux_nexux-data:/data -v "$PWD:/out" \
  busybox tar czf /out/nexux-data-backup.tar.gz -C /data .
```

Treat that archive as secret — the database stores API keys and tokens in
plaintext. A configuration export (sealed with a passphrase) is the safer
artifact when you only need the configuration rather than a full restore.

## Upgrading

```bash
git pull && docker compose up -d --build
```

Migrations run on the first database connection (`NEXUX_MIGRATIONS_DIR`), so
there is no separate migrate step. The volume survives rebuilds — which is why
`NEXUX_DATA_DIR=/data` matters: without it the indexes and the SSH key would
live in an image layer and vanish on every rebuild, locking the install out of
sandboxes it had already provisioned.

## Troubleshooting

**Terminal will not connect.** `NEXUX_WEB_ORIGIN` does not match the URL in the
address bar, or 3002 is not reachable. `docker compose logs nexux | grep -i terminal`.

**ClickUp "Connect" fails on the consent screen.** The `redirect_uri` the server
sent is not one the app has registered. Check what it actually sends:

```bash
curl -sI "$NEXUX_WEB_ORIGIN/api/clickup/oauth/start" | grep -o 'redirect_uri=[^&]*'
```

If that is not the string shown in Settings → Integrations → ClickUp, then
`NEXUX_WEB_ORIGIN` is unset or stale (a bare `0.0.0.0` means unset). If it is
correct and ClickUp still refuses it, ClickUp is rejecting a private-IP `http://`
URL — put a hostname with TLS in front and point `NEXUX_WEB_ORIGIN` at it:

```bash
tailscale serve --bg 3030          # → https://<node>.<tailnet>.ts.net
```

**Search returns nothing.** The model was never pulled: `docker compose exec
ollama ollama list` should show `nomic-embed-text`. Re-index from the project's
page afterwards.

**Sandbox launch fails immediately.** Check the tools are present:
`docker compose exec nexux sh -c 'terraform version; ssh -V; git --version'`.

**Cannot reach the dashboard at all.** `tailscale status` on both ends, and
confirm `NEXUX_BIND` matches the VM's current Tailscale address — it changes if
you remove and re-add the machine.
