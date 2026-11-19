# 27 — A Nexus host on a machine you already have

Status: **shipped** (2026-09-26) — create, update, destroy and a terminal for
hosts on an endpoint, walked on a real LAN endpoint (phase 4) except destroy,
which is left for when that host is no longer wanted.
Depends on [spec 19](19-nexus-host-provisioning.md) (Nexus hosts) and
[spec 26](26-remote-docker-endpoints.md) (Docker endpoints), both shipped.

## Goal

Run a 24/7 Nexux on a machine already registered as a Docker endpoint — a
workstation or home server on the LAN — instead of renting a VM. Same row in
the Nexus hosts list, same "open it over the tailnet", same export/import to
move configuration onto it. No Terraform, no cloud credential, nothing
installed on the machine itself beyond the containers.

## What a host is today

A spec 19 host is a VM that Terraform creates and cloud-init turns into
**a compose stack plus the plumbing around it**. The stack itself is small
([template-host.ts:156](../packages/sandbox/src/template-host.ts:156)): the
Nexux image and Ollama, two named volumes, no docker socket (D-34). Everything
else the cloud-init does is plumbing:

| Cloud-init step | Why it exists on a VM |
|---|---|
| Install Docker | Fresh VM |
| Install Tailscale **on the host OS**, `tailscale up`, bind ports to the tailnet IP | The app has no authentication; nothing may listen on a public address (D-34) |
| `docker login` to GHCR when the image is private | Pull it |
| systemd path unit watching `/opt/nexus-host/control` | Self-update from the host's own dashboard without a docker socket |
| Marker file `tailscale_ip=…` | How the laptop learns the bootstrap finished |

On an endpoint, Docker exists and Terraform has nothing to create. What
remains is: get the stack running there, keep it off the LAN, and replace the
bits that assumed root on a VM we own.

## Design

### A third host provider

`NexusHost.provider` gains `"docker-endpoint"` alongside `civo | aws`, with:

```prisma
model NexusHost {
  // …
  dockerEndpointId String?          // provider "docker-endpoint" only
  dockerEndpoint   DockerEndpoint? @relation(fields: [dockerEndpointId], references: [id], onDelete: Restrict)
}
```

`onDelete: Restrict`, not `SetNull`: a host row whose endpoint vanished can
neither be updated nor destroyed. The endpoint's DELETE route already refuses
while sandboxes use it; it refuses while a live host does, too.

For these rows `region` = the endpoint's name, `size` = `"docker"`,
`instanceId` = the compose project name, `publicIp` = null. `workDir` holds
the rendered compose file (below) instead of Terraform state. Everything that
lists, polls and opens hosts keeps working off the same columns.

### The stack, tailnet-only, with no host-OS changes

Tailscale moves **into the stack** as a sidecar container, and Nexux joins its
network namespace. Nothing is published on the machine at all:

```yaml
services:
  tailscale:
    image: tailscale/tailscale:stable
    hostname: ${NAME}                 # the MagicDNS name
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY}        # from the saved Tailscale credential
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "true"             # no /dev/net/tun, no NET_ADMIN
      TS_EXTRA_ARGS: ${TS_EXTRA_ARGS}  # --login-server for Headscale
    volumes: [ts-state:/var/lib/tailscale]
    restart: unless-stopped

  nexux:
    image: ${IMAGE}
    network_mode: service:tailscale   # its only network is the tailnet
    environment: { … as spec 19, minus NEXUX_BIND … }
    volumes: [nexux-data:/data, nexux-workspace:${HOST_WORKSPACE_DIR}]
    depends_on: [tailscale, ollama]

  ollama: { … unchanged; reached as ollama:11434 … }
```

- **No `ports:` anywhere.** In userspace mode tailscaled accepts tailnet
  connections and dials them into its own namespace, where Nexux listens on
  3030/3002. The LAN sees nothing; the tailnet sees the app. Same boundary as
  D-34, reached without touching the machine's OS or firewall.
- **Userspace, not kernel mode**, so the stack needs no `/dev/net/tun` and no
  `NET_ADMIN` — it runs on any daemon the endpoint probe accepts.
- The Tailscale credential is **required, with an auth key**, exactly as for a
  VM host and for the same reason: an unattended stack cannot finish a
  browser login, and a Nexux the tailnet cannot reach is a Nexux nobody should
  expose any other way.
- **No control-dir bind mount.** It exists for the root systemd unit, which an
  endpoint does not have (see Updates).
- `ts-state` is a named volume, so the node keeps its identity (and MagicDNS
  name) across recreations instead of registering a new device per update.

`renderHostCompose` grows a mode (`"vm" | "endpoint"`) rather than a second
template: the Nexux service's environment and volumes must not drift between
the two.

### Provisioning

No Terraform, no cloud-init. `createHost` with `provider: "docker-endpoint"`:

1. **Preconditions, before the row exists** — same discipline as spec 19:
   endpoint reachable (`probeDockerEndpoint`), Tailscale credential with an
   auth key, image pullable (`assertImagePullable`), and the image publishes
   the endpoint's architecture (the probe recorded `arch`; the registry
   manifest lists platforms). A host that can never start should fail here,
   not after a pull.
2. Render the compose file into `workDir`, plus an `.env` with the secrets
   (`TS_AUTHKEY`, registry token if any) — `0600`, on *this* machine.
3. `docker -H <endpoint> compose -p nexus-host-<name> -f <workDir>/compose.yml
   up -d`. Compose reads the file here and drives the remote daemon; named
   volumes are created there. Nothing is copied to the machine's filesystem.
4. **Bootstrap = the tailnet address appears.** Poll
   `docker -H … exec <ts> tailscale ip -4` until it answers, then
   `docker -H … exec <nexux> node -e "fetch('http://127.0.0.1:3030/api/health')…"`
   until the app does — `node`, because it is the one binary the image is
   certain to have. Record `tailscaleIp`/`tailscaleName`, status `running`. This
   replaces the marker file.
5. Ollama model pull: `docker -H … exec <ollama> ollama pull
   nomic-embed-text` when `pullEmbeddingModel`, logged, non-fatal — as today.

**Registry auth without touching the user's docker config.** `docker login`
stores credentials *client-side*, in `~/.docker/config.json` — this machine,
not the endpoint. Pulls for a private image run with `DOCKER_CONFIG` set to a
temp directory holding only that login, removed afterwards.

**Secrets never land on the endpoint's disk outside Docker.** The auth key
reaches the tailscale container as an env var; its state (not the key) is what
persists in `ts-state`. `.env` stays on this machine.

### Updates

Spec 19 has two routes: from the laptop over SSH, and from the host's own
dashboard via the control dir + systemd unit. On an endpoint:

- **From the install that created it:** `docker -H … compose pull && up -d`
  with the same compose file. Volumes kept (never `down -v`). This is
  `updateHost`'s endpoint branch.
- **From the host's own dashboard:** through the stack's `updater` service
  (phase 5, below) — the endpoint's stand-in for a VM's root systemd unit.

### Destroy

`docker -H … compose -p … down --volumes`, then remove `workDir` and the
managed SSH alias, if any. **Volumes go too** — that is what destroying a VM
host does, and a "destroyed" host whose database silently survives on someone's
workstation is worse than an explicit loss. The confirm dialog says: *this
deletes the host's database, credentials and checkouts on <endpoint> — export
first if you want them.* Export already exists (Backup & migration).

The tailnet device is ephemeral only if the auth key is (spec 19 requires
ephemeral keys); otherwise it lingers in the admin console, as it does for VM
hosts.

### Reaching it

- **Open** — `http://<tailscaleName|tailscaleIp>:3030`, unchanged.
- **Terminal into the host** — spec 19 opens `ssh://` to the VM. An endpoint
  host has no sshd of its own; the terminal opens
  `docker://<endpointId>@nexus-host-<name>-nexux-1` (spec 26 phase 3). VS Code
  stays hidden, as for remote sandboxes.
- **Move configuration onto it** — Backup & migration's export/import, unchanged.

## Not in v1

- **Sandboxes launched from the host itself.** The host has no docker socket,
  so its "local" sandboxes cannot exist; it can use cloud sandboxes, or —
  later — register its own endpoint over SSH, which needs a key inside the
  container and is its own decision.
- **Kernel-mode Tailscale** (better throughput) — opt-in later if userspace
  proves slow for the terminal or the browser session.
- **Keeping data on destroy.** A "stop, keep volumes" action is plausible;
  v1 has start/destroy only, matching VM hosts.

## Security

- Nothing published on the endpoint's interfaces; the only door is the
  tailnet, via a node that requires the user's own auth key. Same property as
  D-34, now enforced by the absence of `ports:` rather than a bind address.
- Endpoint access is already root on that machine (spec 26); creating a host
  there asks for nothing more.
- The Tailscale auth key and any registry token stay in `.env` (`0600`) on
  this machine and in container env on the endpoint. They are never written
  into the compose file, the row, or the log.

## Tests

- `renderHostCompose({ mode: "endpoint" })`: no `ports:`, `network_mode:
  service:tailscale` on nexux, no control-dir mount, no secret values inlined;
  the Nexux service block identical between modes except the documented diffs.
- `createHost` preconditions: unreachable endpoint, missing/keyless Tailscale
  credential, arch mismatch — each refused before a row exists.
- Endpoint DELETE refused while a live host references it.
- `updateHost` endpoint branch runs `pull` + `up -d`, never `down`.
- Destroy runs `down --volumes` with the project name, and only after the
  row is `destroying`.
- Manual, end to end on `devbox`: create → reach it over the tailnet →
  export/import configuration onto it → update to a new tag (data survives)
  → destroy (device and volumes gone). Confirm with `ss -ltnp` on the
  endpoint that nothing new listens on the LAN.

## Order

1. ✅ Schema (`provider` value, `dockerEndpointId`), endpoint-DELETE guard,
   `renderHostCompose` endpoint mode + tests.
2. ✅ `createHost`/provision/poll for endpoints; host form gains the provider;
   registry auth via temp `DOCKER_CONFIG`.
3. ✅ Update and destroy branches; terminal target for endpoint hosts; the host
   dashboard's Update button explains itself.
4. ✅ Manual E2E on a real endpoint (destroy pending — see As built).
5. ✅ Self-update from the host's own Settings: an `updater` service.

## As built (phase 1)

- `renderHostCompose({ mode: "endpoint", name })` renders the stack above.
  The Nexux `environment` block is shared with the VM mode (a test compares
  the two), and the VM output is byte-identical to before. Validated with
  `docker compose config`, which also confirmed Nexux still resolves
  `ollama` while living in the Tailscale container's network namespace — the
  sidecar sits on the project's default network.
- Removing an endpoint detaches *destroyed* hosts in the same transaction
  (their FK restricts), and refuses while a live one exists. The endpoints
  list shows a host count beside the sandbox count.

## As built (phase 2)

- **Platforms come from the pull check.** `assertImagePullable` now GETs the
  manifest it already probed and returns the index's platforms (attestations
  excluded); a single-platform manifest returns null — no opinion. The endpoint
  arch from the probe is mapped (`x86_64` → `amd64`) and compared.
- **Order of the bootstrap** is chosen so each failure names its cause: pull
  every image (registry), start tailscale and wait for its IPv4 (auth key —
  its log is captured on timeout), write `NEXUX_WEB_ORIGIN=http://<ip>:3030`,
  start the rest, then poll `/api/version` from inside the container with
  `node` (not `/api/health`, which probes terraform and docker).
- **Temp `DOCKER_CONFIG`** links `~/.docker/cli-plugins`, because that is where
  Docker Desktop keeps `compose`; without it the pull would fail with
  "unknown command: compose".
- **`NEXUX_TEST_HOST_PROVISION=skip`** stops route tests after the row: an
  endpoint named in a test could be a live machine on this network.
- A running server keeps its Prisma client in memory; a new column needs a
  restart before routes that select it stop answering 500.

## As built (phase 3)

- **Terminal: `docker-host://`, not `docker://`.** The sandbox scheme execs as
  the agent user (`-u nexus`) into `/opt/nexus`; the host's app container runs
  as the image's own user (`nexux`), where that fails with "unable to find
  user". `docker-host://<endpointId>@<container>` execs as the image's user
  into `/app`, and is refused without an endpoint id. The row also offers
  the `docker -H … exec -it … bash` to copy.
- **Update re-renders `compose.yml`** (the file says it is overwritten on
  update) but never `.env`, which holds the auth key and only exists there;
  without it, update refuses rather than guess.
- **Destroy needs only the project name**, so it still works if the host's
  local files were lost.
- **Self-update on the host** answers with where to update from
  (`NEXUX_HOST_KIND=endpoint`), and Settings on the host says so up front.

## As built (phase 4 — the walk on a real endpoint)

On `devbox` (x86_64, Docker 29, reached as `ssh://devbox`):

- **The precondition caught the real failure first.** Three saved GitHub
  tokens were refused before any row existed — none had `read:packages` —
  naming the missing scope. With a token that had it, the host was created.
- **Bootstrap:** pull → tailscale → tailnet address `100.64.0.30` →
  app healthy → `running`, MagicDNS `nexus-e2e.<tailnet>.ts.net`. The app
  answered over the tailnet from another machine.
- **Nothing on the LAN:** `ss -ltn` on the endpoint showed nothing on
  3030/3002/11434; `docker ps` showed no published ports.
- **Terminal assumption held:** `docker exec` into the app container lands as
  `nexux` in `/app` with bash — what `docker-host://` relies on.
- **Update:** pull + `up -d` through the endpoint answered "Already up to
  date" (the image had just been pulled), and the app kept answering.
- **Destroy:** not run on this host yet — it is in use. The unit tests cover
  the command; walk it when the host is retired.

## Phase 5 — self-update from the host's own Settings

A VM host updates itself through a note in `/host-control` that a root
systemd unit acts on (D-34: the app never gets the docker socket). An endpoint
host had nothing on its machine to act on the note, so phase 3 sent updates
through the install that created it. Phase 5 puts the stand-in *in the
stack*:

- **`updater` service** (`docker:cli`): the only container with
  `/var/run/docker.sock` — root on the endpoint, as the unit is on a VM — and
  it acts on exactly one thing, `update-requested` in the shared
  `host-control` volume. The app mounts that volume at `/host-control`, the
  VM path, so the same Settings button and log reader work on both.
- **The script** (`renderEndpointUpdater`) consumes the request first, pulls
  and `up -d`s `tailscale nexux ollama` — never itself, since recreating its
  own container kills the run — never `down`, and logs `[nexus-update]
  started/finished/FAILED` like the VM updater. It opens `/control` `1777`:
  the app runs as `nexux`, and sticky keeps it from removing the log.
- **Its config** (`compose.yml`, `.env`, registry login, the script) lives in
  a `host-config` volume only it mounts, written after every `up -d` through
  `docker exec -i` on stdin. **This is the one place the host's secrets rest
  on the endpoint** — inside a Docker volume, never visible to the app.
  Accepted in exchange for self-update (the machine is the user's own).
- **Hosts from before phase 5** gain the updater the first time they are
  updated from the install that created them; until then their button says so.

Walked on `devbox`: an update from here recreated the stack with the updater
(data survived: projects still there), its files arrived `600`, `/control`
`1777`; a note written as `nexux` inside the app container was consumed and
the stack pulled and recreated, logged in the VM format.

## Phase 6 — a host that launches local sandboxes over SSH

Status: **draft** (2026-09-28).

### Why

A host on a Docker endpoint cannot launch a local sandbox. Asked to, it says
"Docker is not available … start Docker Desktop" — advice for a laptop, not
a container on devbox. The obvious fix, registering devbox as an endpoint
from the host's own Settings, cannot work today, for three reasons:

1. **No `docker` client in the image.** The Dockerfile installs
   `openssh-client`, `git` and `terraform` only, and says why: the local
   provider "is deliberately NOT supported in this image".
2. **No key devbox accepts.** `docker -H ssh://…` runs the system `ssh`,
   which on the laptop finds the user's own key and `~/.ssh/config`. The
   container has neither.
3. **`ssh://devbox` is a laptop alias.** It resolves through the laptop's
   `~/.ssh/config`; inside the container it names nothing.

Mounting the endpoint's docker socket into the app stays out — it is
root-equivalent on that machine, which D-34 and phase 5 already refused.
Phase 6 gives the host what the laptop has instead: a key, a client, an
address it can reach.

### Shape

```
host's Settings → Docker endpoints
  "This host's SSH key"  ssh-ed25519 AAAA… nexus-host-nexus-e2e   [Copy]
  "Run on the target:    echo '<key>' >> ~/.ssh/authorized_keys"
  Add endpoint: ssh://dev@192.168.1.35      → probe → endpoint row
launch (local) ──docker -H ssh://dev@192.168.1.35──▶ devbox's dockerd ──▶ sandbox container
```

### Pieces

1. **The `docker` client in the image** — the static CLI from Docker's own
   releases (client only, no daemon), pinned like terraform. The Dockerfile
   note becomes: the local provider runs over SSH to an endpoint, never on a
   mounted socket.
2. **An endpoint key of its own** — `<dataDir>/ssh/endpoint_ed25519`, made on
   first use and kept in the data volume, so updates keep it. It is separate
   from the sandbox keypair: authorizing it on a machine must not also be a
   key every cloud sandbox holds, and removing it must not lock out any
   sandbox. Its comment names the host (`nexus-host-<name>`), so the target's
   `authorized_keys` says whose it is.
3. **SSH config the client picks up** — the existing managed config in the
   data dir gets one block per registered endpoint: `IdentityFile` = the
   endpoint key, `IdentitiesOnly yes`, `StrictHostKeyChecking accept-new`, a
   private `UserKnownHostsFile` in the data dir. `ensureUserSshInclude` runs
   at startup on a host, because the container's home is rebuilt on every
   update and the `Include` line with it.
4. **Settings on a host** — the Docker endpoints card shows the host's public
   key with Copy and the one line to run on the target. The address field
   explains that it must resolve from the host: a LAN IP or DNS name, not a
   laptop's ssh alias. The existing probe gives the verdict — reachable, not
   rootless, the user in the `docker` group — and "Test for sandboxes"
   (spec 28) covers DNS, privileged containers and disk space.
5. **Reachability** — the app shares the Tailscale sidecar's network
   namespace. In userspace mode that namespace reaches the LAN through the
   compose bridge, so an address like 192.168.1.35 works — as long as the
   target's firewall lets the bridge in (see As built, step 3: packets arrive
   from the stack's `10.201.x.0/24`, not from the LAN). Tailnet addresses
   do not work from there without Tailscale's proxy. The address hint says
   to use the LAN address; supporting tailnet targets is out of scope.
6. **The destination picker on a host** — "This machine" is hidden, because a
   host has no daemon of its own. With no endpoint registered, the Local card
   says to register one, with a link. With one, it is chosen by default and
   saved with the project, as phase 2 of spec 26 already does.
7. **The error, on a host** — "Docker is not available" becomes "This Nexus
   host has no Docker of its own — register the machine it runs on (or
   another) as a Docker endpoint in Settings → Cloud", with the link. On a
   laptop the message is unchanged.

### What stays the same

- Endpoints, probe, terminal (`docker-host://`), browser session forwarding,
  seed pushes and resets: all already go through `docker -H`. They need
  nothing new once the client, the key and the address work.
- Mount-only repositories stay refused on an endpoint (spec 26): the host's
  checkouts live in its own volume, which the endpoint cannot see. Sandboxes
  clone from git as usual.

### Security

- The key grants what the target user can do. In the `docker` group that is
  root-equivalent on the target, the same as the laptop's access. The card
  says so, and suggests a dedicated user on shared machines.
- The private key never leaves the data volume: it is not shown, not
  exported (spec 18 already excludes machine state), and not sent anywhere.
- The first connection records the target's host key (`accept-new`). A
  changed host key afterwards is refused, not re-accepted.

### Not in phase 6

- Tailnet addresses as endpoint targets (needs the userspace proxy).
- Auto-registering "the machine this host runs on" — the host does not
  reliably know an address and user for it; one paste is clearer.
- A socket mount, under any flag.

### Order

1. Image: the static `docker` client. Endpoint key + managed SSH config +
   the startup `Include`. Unit tests for the config block and the key.
2. Settings on a host: key card, address hint, picker without "This
   machine", the host-specific error.
3. The walk: from devbox's own host, register `ssh://dev@192.168.1.35`,
   run Test for sandboxes, launch a local sandbox, open its terminal, destroy
   it.

### As built (phase 6, step 1)

- **Image:** the static Docker CLI 29.1.3 (client only), extracted from
  `download.docker.com/linux/static/stable/{x86_64,aarch64}` in the same
  `RUN` as terraform. The tooling layer was built for both `linux/arm64` and
  `linux/amd64` and runs `docker --version` beside `ssh -V`.
- **Key:** `ensureEndpointKeypair(dataDir, comment)` →
  `<dataDir>/ssh/endpoint_ed25519`, comment `nexus-host-<hostname>`, beside
  (never replacing) the sandbox keypair; both share one `ensureKeypair`.
- **SSH config:** `upsertEndpointSshHost` / `removeEndpointSshHost` keep one
  `# >>> nexux endpoint <address> >>>` block per endpoint in the managed
  config — `Host <address>`, the endpoint key, `IdentitiesOnly`,
  `accept-new` into the managed known_hosts, `ConnectTimeout 15`. User and
  port stay in the `ssh://` URL. A test runs `ssh -G` against it to confirm
  ssh resolves that key and the URL's user.
- **Only on a host** (`NEXUX_ROLE=host`): creating an endpoint prepares its
  block before the probe and drops it if the probe fails; deleting one drops
  it; startup restores the `Include` line and every block, because the
  container's home is rebuilt on each update. On a laptop nothing is written
  (a route test pins that the managed config is unchanged).

### As built (phase 6, step 2)

- `GET /api/docker-endpoints/host-key` → `{ isHost, publicKey }` (the key
  is made on first ask; the private half is never in a response — a route
  test checks the body).
- Settings → Cloud → Docker endpoints on a host: an "This host's SSH key"
  card (the key and the `echo '…' >> ~/.ssh/authorized_keys` line, each with
  Copy, and the root-equivalence note), an empty-state that says the host
  has no Docker of its own, a LAN-address placeholder, and a hint that a
  laptop ssh alias and a Tailscale address will not resolve from the host.
- Which Docker on a host: no "This machine"; the first endpoint is picked
  when none is (unless mount-only repos block it); with none registered, an
  amber note links to Settings. The launch error on a host names the fix
  instead of Docker Desktop.
- On a laptop nothing changes; checked in the browser (no key card, no
  console errors). The host view is walked in step 3, on devbox's host.

### As built (phase 6, step 3 — the walk on devbox's own host)

- **Reachability:** the first probe timed out. sshd listened on `0.0.0.0:22`,
  but devbox's ufw (`DEFAULT_INPUT_POLICY=DROP`) only allowed 22 from
  `192.168.1.0/24`, and the host's packets arrive from its compose bridge
  (`10.201.1.0/24`) — the kernel log showed `[UFW BLOCK] SRC=10.201.1.3
  DST=192.168.1.35 DPT=22`. One rule on the target fixed it:
  `ufw allow from 10.201.0.0/16 to any port 22 proto tcp`. Nothing in Nexus
  changed; a target with a default-deny firewall needs the same line.
- **Register + test:** `ssh://dev@192.168.1.35` probed as Docker 29.7.2,
  x86_64, 31 GB; "Test for sandboxes" passed all six checks.
- **Wizard:** Which Docker showed only devbox, picked by default, no "This
  machine". The sandbox row read "local · docker @ devbox".
- **Launch:** the container came up on devbox and the 947 MB acme seed
  was pushed in 3 s — then the launch failed at the 20-minute deadline while
  the seed was still restoring (spec 29's issue, not this phase's): the dump
  is one autocommitted INSERT per row and each waited on a WAL fsync
  (`wait_event = WalSync`, 161 MB in 59 min). Fixed in the restore: postgres
  seeds run with `PGOPTIONS="-c synchronous_commit=off"` — the same dump then
  restored in 199 s. The local bootstrap deadline also grows by the seed's
  size allowance (`seedWaitSeconds`), so a slow push can't eat it.
- **Terminal:** `docker://<endpointId>@nexux-acme-d0ce79` through the
  host's terminal server opened a shell as `nexus` in the container, over
  the host's endpoint key; postgres in the stack answered healthy.
- **Destroy:** from the host; container and volumes gone on devbox.
- **Follow-ups, done:** the project's Terminal tab showed "Connection error"
  only in the desktop app's browser pane, which blocks any port other than
  the page's (even a plain `fetch` to `:3002` failed there); in Chrome the
  same tab opens a shell on the host. The review step's "Runs on" now names
  the endpoint ("Docker container on devbox"), and "Open files in Finder"
  is hidden for an endpoint's sandbox — the reveal route refuses it too,
  since mount-only repos never run there.
