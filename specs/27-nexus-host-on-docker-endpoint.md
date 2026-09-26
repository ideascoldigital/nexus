# 27 — A Nexus host on a machine you already have

Status: **phase 1 shipped** (2026-09-26) — schema, endpoint-removal guard,
the endpoint compose stack. Nothing provisions a host on an endpoint yet.
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
- **From the host's own dashboard:** not possible — it has no docker socket
  (D-34) and there is no root-side unit to ask. The Update button there says
  so and names the install to update from, instead of offering an action that
  cannot work. (The host knows it runs on an endpoint via an env var the
  compose sets, `NEXUX_HOST_KIND=endpoint`.)

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
- **Self-update from the host's dashboard** (see Updates).
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
- Manual, end to end on `omarchy`: create → reach it over the tailnet →
  export/import configuration onto it → update to a new tag (data survives)
  → destroy (device and volumes gone). Confirm with `ss -ltnp` on the
  endpoint that nothing new listens on the LAN.

## Order

1. ✅ Schema (`provider` value, `dockerEndpointId`), endpoint-DELETE guard,
   `renderHostCompose` endpoint mode + tests.
2. `createHost`/provision/poll for endpoints; host form gains the provider;
   registry auth via temp `DOCKER_CONFIG`.
3. Update and destroy branches; terminal target for endpoint hosts; the host
   dashboard's Update button explains itself.
4. Manual E2E on a real endpoint.

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
