# 26 — Local sandboxes on another machine's Docker

Status: **phases 1–3 shipped** (2026-09-26, D-79) — endpoints can be added;
a local sandbox can be launched, exec'd into, paused, resumed and destroyed on
one; the in-app terminal and the browser session reach it. Still open: VS Code
attach (not in v1) and metrics per endpoint (phase 4). What changed from the
draft is under *As built* at the end.

## Goal

Run Nexux on machine A (a laptop) and put its container sandboxes on machine B
(a workstation or home server on the LAN / tailnet) — B's CPU, RAM and disk,
A's dashboard — without B having to run Nexux, Terraform, or anything but
Docker and sshd.

Out of scope: turning B into a **Nexus host** (spec 19). That is "run Nexux
itself on B" and stays a Terraform-provisioned cloud VM for now; a "bring your
own machine" host provider is a separate spec if we want it.

## What already works, by accident

Every Docker call in the container path spawns `docker` without an explicit
`env` (`run()` in [local.ts:34](../packages/sandbox/src/local.ts:34)), so
starting Nexux under `DOCKER_HOST=ssh://user@b` already moves `run`, `exec`,
`start`, `stop`, `rm`, `build` and `docker info` to B. The base image builds on
B (the build context is uploaded), the memory ceiling is read from B's daemon,
and repos with a clone URL clone inside the container. That is the proof of
concept; this spec is about the three things that silently break and about
not making it a process-wide env var.

## What breaks

1. **Bind mounts** ([local.ts:230-236](../packages/sandbox/src/local.ts:230)).
   `-v ${mountPath}:/opt/nexus/<repo>` is resolved against **B's** filesystem.
   A repo without a clone URL gets an empty directory that Docker creates on
   B — no error, a sandbox working on nothing.
2. **Browser session** (spec 23, [local.ts:268](../packages/sandbox/src/local.ts:268)).
   `-p 127.0.0.1::6080` binds on B's loopback. `browserWsPort()` reads the
   port back correctly, but `publishedPortFor`
   ([browser-session.ts:197](../apps/web/src/lib/browser-session.ts:197))
   connects to A's `127.0.0.1` — the panel never connects.
3. **Global env is the wrong unit.** `DOCKER_HOST` on the Nexux process moves
   *everything*: the stack runner ([stack/runner.ts](../apps/web/src/lib/stack/runner.ts)),
   the stack lock ([stack-lock.ts](../apps/web/src/services/stack-lock.ts)) and
   the harness (`packages/harness`) — which are about the developer's own
   machine — plus every existing local sandbox, which then "disappears"
   because it lives on A's daemon. And the terminal server (`:3002`) is a
   separate process that may not share the env at all.

## Design

### A sandbox remembers which daemon it lives on

New model, one row per remote daemon:

```prisma
model DockerEndpoint {
  id        String    @id @default(cuid())
  name      String    // "workstation" — shown in the destination picker
  host      String    // ssh://user@b[:port] — ssh only, see Security
  /** Last `docker version` / `docker info` probe, for the settings list. */
  serverVersion String?
  arch      String?   // B's arch: the base image is built there, natively
  memTotalMb Int?     // not BigInt: that does not survive NextResponse.json
  lastCheckedAt DateTime?
  lastError String?
  sandboxes Sandbox[]
  createdAt DateTime  @default(now())
}

model Sandbox {
  // …
  dockerEndpointId String?          // null = this machine's daemon
  dockerEndpoint   DockerEndpoint? @relation(fields: [dockerEndpointId], references: [id])
}
```

`provider` stays `"local"`. The ~30 `provider === "local"` checks mean
"container transport, no SSH, no Terraform", and that is still true on B.
The endpoint is a property of *where* the container runs, not *what kind*
of sandbox it is — so no new provider value and no fan-out through the UI.

Changing or deleting an endpoint never re-homes a sandbox: deletion is refused
while sandboxes reference it (same rule as a credential in use).

### One way to build a docker argv

`packages/sandbox/src/docker-endpoint.ts`:

```ts
export type DockerTarget = { host: string | null }; // null = default daemon

/** ["-H", host] or [] — prefix for every docker argv in the container path. */
export function dockerHostArgs(t: DockerTarget): string[];
```

`-H` rather than `DOCKER_HOST` in the env: explicit in argv (so it shows in
logs and tests), no env to thread into node-pty, and it cannot leak into a
child that was not meant to see it.

Call sites that take a `DockerTarget`:

| Site | Today |
|---|---|
| `local.ts` — every exported function | `run("docker", …)` |
| `remote.ts` container transport — `execRemote`, `fetchRemoteDir`, `pushLocalDir`, `sandboxShellCommand` | `bin = "docker"` |
| `terminal-server.ts` | `pty.spawn("docker", dockerArgs)` |
| `sandbox-metrics.ts` | `docker ps` / `stats` / `exec df` |
| `browser-session.ts` | `browserWsPort()` |

`SandboxAddress` gains `dockerHost?: string`; `agent-core.ts` fills it from the
row. Metrics iterate per endpoint (this machine + each endpoint) and label
results with the endpoint id — `docker ps` on A no longer tells us about B.

Explicitly **not** routed: stack runner, stack lock, harness. They run the
developer's repos on the developer's machine.

### Terminal target

`docker://<container>[/path]` keeps meaning this machine. Remote containers
use `docker://<endpointId>@<container>[/path]`; the server resolves the id to
a host through the DB. The client never sends a raw `ssh://` host into the
terminal server — same reasoning as the strict charset on the existing regex
([terminal-server.ts:147](../packages/terminal/src/terminal-server.ts:147)):
the cwd is a URL typed by a browser, not a trusted argv.

### Bind mounts: refuse, don't guess

At create time, if the destination is an endpoint and any repo has no
`repoUrl` (i.e. would mount `mountPath`), the request fails with a 400 naming
the repos: *"workstation can't see /Users/…/api — give it a clone URL or run
the sandbox on this machine."* The picker disables the endpoint with the same
text before submit.

Considered and deferred:

- *Sync the folder (rsync / `pushLocalDir`) at create.* Turns the sandbox into
  a copy that silently diverges from the files the user edits on A — the whole
  point of a mount is that it doesn't. Worth doing only as an explicit
  "upload a snapshot" option, later.
- *Interpret `mountPath` as a path on B.* Correct when B has the repo checked
  out too, but the path is picked with A's folder picker. Could come back as a
  per-endpoint "path on this machine" field.

### Browser session: forward through the same SSH

A remote sandbox is reached exactly like a cloud one: `ssh -L
127.0.0.1:<free>:127.0.0.1:<port>` to B, where `<port>` is what `docker -H …
port` reports. The forward builder already exists and already pins
`127.0.0.1` on both ends
([browser-session.ts:115-130](../apps/web/src/lib/browser-session.ts:115)); it
needs to accept the endpoint's `user@host[:port]` instead of the sandbox's
public IP. The container keeps publishing on **B's** loopback only — the VNC
bridge is never offered to the LAN.

This is the reason endpoints are ssh-only in v1: over `tcp://` + TLS there is
no channel to forward through, and the alternative (publishing 6080 on B's LAN
address) is the thing spec 23 forbids.

### SSH connection reuse

Docker's ssh transport opens a new SSH connection per CLI invocation, and the
UI polls (status, metrics, bootstrap log). Register each endpoint in the
managed SSH config (`upsertSandboxSshHost`,
[ssh-config.ts:57](../packages/sandbox/src/ssh-config.ts:57)) with
`ControlMaster auto` / `ControlPersist` (reuse `SSH_CONTROL_PERSIST_SECONDS`),
and store `host` as `ssh://<alias>` so both `docker -H` and the browser
forward ride the same master connection.

### Adding an endpoint

Settings → Docker endpoints → Add: name + `ssh://user@host[:port]`.
`POST /api/docker-endpoints` probes before saving:

1. `docker -H <host> version --format '{{.Server.Version}}'` — reachable,
   key auth works non-interactively (`BatchMode=yes`), user can talk to
   the daemon.
2. `docker -H <host> info --format '{{json .}}'` — `Architecture`,
   `MemTotal`, and `SecurityOptions` containing `rootless` → **refused**:
   the sandbox needs `--privileged` for Docker-in-Docker.
3. Save the probe results on the row; "Check again" re-runs it.

Errors are shown verbatim from stderr (tail), e.g. `permission denied while
trying to connect to the Docker daemon socket` → "add `user` to the `docker`
group on B".

### Destination picker

The create-sandbox destination list becomes: *This machine* · each endpoint ·
Civo · AWS. `project-sandboxes.tsx` already keys "local" UI off
`provider`; the only visible difference on a remote row is a badge with the
endpoint name, and the VS Code action (below).

## Security

- **ssh:// only.** `tcp://` is refused at the API; plain tcp is root on B for
  anyone who can reach the port, and tcp+TLS has no forward channel (above).
- Talking to B's daemon is root on B. The add dialog says so in one line; it
  is the user's machine and the user's call, same as adding themselves to the
  `docker` group.
- The env allowlist ([env.ts](../packages/sandbox/src/env.ts)) is unchanged:
  what reaches a sandbox on B is exactly what reaches one on A.
  `civo_api_key`, `telegram_*` still never leave A.
- The host string is validated (`ssh://`, strict host/user charset, optional
  numeric port) before it is ever put in argv, and `-H` is always followed by
  it as a separate argv element — never interpolated into a shell string.

## Not in v1

- **VS Code attach** on a remote container: Dev Containers can do it via a
  docker context, but wiring that is its own work. The action is hidden on
  remote rows.
- **Moving a sandbox** between daemons.
- **Endpoint as a scheduled-task target** (`task-scheduler.ts`): tasks run on
  existing sandboxes, so they follow the sandbox's endpoint already; picking a
  *new* sandbox's endpoint from a schedule waits for the picker to land.
- **B as a Nexus host** (see Goal).

## Tests

- `dockerHostArgs` — null → `[]`; valid host → `["-H", host]`; rejects
  `tcp://`, spaces, quotes, leading `-`.
- `local.ts` / `remote.ts` argv snapshots with and without a target (the
  existing tests already assert argv; extend them).
- Terminal regex: `docker://c`, `docker://id@c/path` accepted;
  `docker://ssh://…`, `docker://-H@c` rejected.
- Create route: endpoint + repo without `repoUrl` → 400 naming the repo.
- Endpoint probe: rootless `SecurityOptions` → refused.
- Manual, end to end: A = macOS laptop, B = Linux box on the tailnet. Create
  a sandbox on B from a clone URL, run a task, open the terminal, open the
  Browser panel, pause/resume, destroy. Confirm on B that 6080 is bound on
  `127.0.0.1` only (`ss -ltnp`).

## Order

1. ✅ `DockerEndpoint` model + migration + probe + settings UI (usable,
   nothing routes to it yet). `Sandbox.dockerEndpointId` landed here too.
2. ✅ `dockerHostArgs` threaded through `local.ts` and the container transport;
   picker; bind-mount refusal. Sandboxes on B work
   except terminal and browser.
3. ✅ Terminal target + browser forward.
4. Metrics per endpoint.

## As built (phase 1)

- **Machine-level, not workspace-scoped.** Like `NexusHost`: an endpoint is a
  place containers run, not a secret, and two workspaces on one install share
  the same machines.
- **`Sandbox.dockerEndpointId` shipped in phase 1**, not 2 — refusing to remove
  an endpoint that live sandboxes use needs the column, and one migration is
  less churn than two. `ON DELETE SET NULL`: destroyed sandboxes keep their
  rows for history. Added with `ALTER TABLE … ADD COLUMN … REFERENCES` rather
  than Prisma's table redefinition, which would copy every Sandbox row.
- **The probe is one `docker info --format '{{json .}}'`**, not `version` then
  `info` — one SSH connection answers reachability, auth, daemon access and the
  facts. It runs `detached` (own session, no controlling terminal) with
  `SSH_ASKPASS_REQUIRE=never`, so a missing key fails in a second instead of
  sitting on a password prompt in the terminal that started the dev server.
- **The user part is optional** (`ssh://host`): it can come from
  `~/.ssh/config`, which is where most LAN machines already have an alias.
- **The host is not editable** (`PATCH` renames only) — repointing a row would
  silently orphan its sandboxes.
- **Probing a real endpoint** (a LAN box whose `known_hosts` entry was stale)
  showed the first cut telling a *changed* host key apart from nothing: it said
  the key "isn't trusted yet", which invites accepting it blindly. The hint now
  names the change and how to clear it if expected.
- Tests: `NEXUX_TEST_DOCKER_PROBE` (JSON `ProbeResult`) stands in for the probe
  in route tests, env-guarded like `NEXUX_TEST_TERRAFORM`.

## As built (phase 2)

- **`Sandbox.dockerHost` is denormalised** from the endpoint at launch (second
  migration). The daemon is part of a sandbox's address, like `publicIp` and
  `instanceId`, and every exec path builds its target from the row — a join on
  each would have touched ~20 call sites for nothing, and the value cannot
  drift because an endpoint's host is not editable. The FK stays for "which
  sandboxes still use this endpoint".
- **`sandboxTarget` requires `dockerHost`** on its input rather than taking it
  optionally, so a caller that `select`ed part of the row and forgot it fails
  typecheck instead of silently exec'ing on this machine's daemon. The only
  failures were tests; the hand-built targets (task-manager's copies, the two
  log routes) were patched by hand.
- **`local.ts` has one private `docker(target, args)`** that every call goes
  through, so a sandbox cannot half-live on two daemons.
- **Mount refusal runs before any daemon is asked**, in the launch, and again
  in `launchLocalSandbox` as a backstop. The picker disables endpoints with the
  same reason when the project has folder-only repos.
- **Reconcile groups by daemon**: Docker Desktop down on the laptop no longer
  implies anything about the workstation's containers.
- **Phase 3 surfaces refuse rather than misbehave**: the row hides terminal,
  VS Code and the browser panel for a remote sandbox, and the vscode route and
  `startBrowserSession` return errors — each would otherwise attach through
  this machine's daemon and find nothing.
- `region` on a remote row is the endpoint's name, so the row reads
  `local · docker @ omarchy` with no UI change.

## As built (phase 3)

- **The terminal server stays database-free.** `startTerminalServer` takes an
  injected `resolveDockerHost(endpointId)`; the web app passes one backed by
  `DockerEndpoint`. The standalone CLI entry has none, so a remote target
  closes with a message instead of exec'ing on this machine's daemon, where
  the container does not exist. The socket is paused during the lookup.
- **One helper builds every terminal target** (`lib/terminal-target.ts`), used
  by the sandbox row and the terminal picker. Restored tabs are pruned by
  container name; the old regex would have read `id@container` as the name and
  dropped every remote tab on reload.
- **The browser forward authenticates as the user, not as Nexux.**
  `endpointForwardArgs` uses the user's ssh config, keys and known_hosts for
  the endpoint — what `docker -H ssh://…` itself uses — with `BatchMode=yes`.
  The sandbox key is authorized inside sandboxes, not on the endpoint.
- **SSH connection reuse (ControlMaster) was not needed yet** and is not done:
  the endpoint is reached through the user's own ssh config, where a
  `ControlMaster auto` for that host already applies if they want it.
- Smoke-tested against a real LAN endpoint with a throwaway busybox container:
  `docker -H … port` read the remote port, the forward served its page, and
  the container was removed.
