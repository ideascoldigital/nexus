# 19 — Provisioning a Nexus host from the UI

## Goal

Create the 24/7 VM that runs Nexux itself from the dashboard: pick a provider,
region and size, and get back a machine on your Tailscale network with the app
running — then move your configuration onto it with the existing export/import
(spec 18). Destroy it from the same panel.

Today this is [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md): six commands, run by
hand, once. That doc stays correct and is the fallback; this spec is about
making the common path a form.

Non-goal: **managing a fleet.** One install may own a handful of hosts, not a
cluster. No orchestration, no health-based replacement, no autoscaling.

## Why this is cheap to build

`@nexux/sandbox` already provisions cloud VMs end to end, and almost all of it
is agnostic about *what* the VM ends up running:

| Reused as-is | Why it fits |
|---|---|
| `renderMainTf(provider)` | Only needs name/region/size/image/ssh key. The Civo firewall is already **SSH-only inbound**, which is exactly right for a Tailscale host. |
| `renderTfVars(spec)` | Same five variables. |
| `applySandbox` / `destroySandbox` / `readOutputs` | Terraform lifecycle, credentials via env only (D-09). |
| `runTerraform` / `terraformAvailable` | Unchanged. |
| `ensureSandboxKeypair` | The install's keypair, so SSH into the host works like SSH into a sandbox. |
| `execRemote` | Reading bootstrap state over SSH. |

What is genuinely new is the **cloud-init**: instead of cloning repos and
installing agent CLIs, it installs Docker + Tailscale and brings up the compose
stack.

## What is deliberately NOT reused

**The `Sandbox` model.** A Nexus host is not a sandbox:

- it has no `projectId` — it belongs to the install, not a project;
- it is never ephemeral and must never be auto-destroyed after a task;
- the local-status reconciliation (D-24) downgrades rows by inspecting
  *Docker containers on this host* — a Nexus host is not one of those, and
  would be marked dead;
- it would appear in every project's Sandboxes tab, which is a lie.

So: a new `NexusHost` model. Sharing the table would save a migration and cost
correctness.

**The sandbox setup wizard.** That drawer is per-project. This is
install-scoped and belongs in Settings, next to Backup & migration — which is
its natural sequel: create the host, then import your configuration into it.

**`SandboxSpec`.** It carries repos, brains, stack launchers, MCP servers —
none of which a host has. A separate `NexusHostSpec` keeps both honest.

## Distribution: registry

The cloud-init pulls a published image (`docker pull ghcr.io/<owner>/nexux`)
rather than cloning and building on the VM.

Building in place would need ≥6 GB of RAM just for the Next build
(`--max-old-space-size=4096` plus the native toolchain) and ~10 minutes per
creation — so the VM would have to be sized for a step it performs once. With a
registry, a 2 GB instance is enough to *run* it and first boot is ~2 minutes.

Consequence: **the image must be published before the panel can create
anything.** That is a real prerequisite, not an implementation detail:

- a public GHCR package needs no credentials on the VM;
- a private one needs a registry token in the bootstrap, which is another
  secret on the instance — prefer public, or a short-lived token.

The panel must therefore validate that the configured image reference is
reachable before provisioning, and say so plainly when it is not. Provisioning
a VM that then fails to pull is the worst outcome: it costs money and looks
like a Nexux bug.

A `hostImage` setting (default `ghcr.io/<owner>/nexux:latest`) makes the
reference explicit and overridable.

## Data model

New migration, one model:

```prisma
model NexusHost {
  id            String    @id @default(cuid())
  name          String    // instance hostname
  status        String    @default("pending") // pending | provisioning | bootstrapping | running | error | destroying | destroyed
  provider      String    // civo | aws
  credentialId  String?   // the cloud credential used; destroy prefers the same account
  region        String
  size          String
  diskImage     String
  instanceId    String?
  publicIp      String?   // provider-assigned; NOT how you reach the app
  tailscaleIp   String?   // 100.x.y.z — the address the dashboard is served on
  tailscaleName String?   // MagicDNS name, when available
  imageRef      String    // exactly what was pulled, for support
  workDir       String    // terraform working directory on disk
  log           String    @default("")
  error         String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  destroyedAt   DateTime?

  credential CloudCredential? @relation(fields: [credentialId], references: [id], onDelete: SetNull)
}
```

`publicIp` is stored but is **not** the way in — nothing is published on it.
It exists for support ("did the VM even come up?") and for the SSH used to read
bootstrap state.

## The Tailscale auth key is a credential

Joining the tailnet unattended needs an auth key (`tskey-auth-…`). It is a
secret with the same lifecycle as every other token here, so it becomes a
`CloudCredential` with a new provider value `tailscale`, `data: { authKey }` —
listed, selectable and maskable like the rest, and it flows through the
existing credential UI with no new secret-handling code.

It must be an **ephemeral, pre-authorized, reusable** key, and the panel says
so: a non-reusable key breaks the second host, and a non-pre-authorized one
leaves the machine pending approval — which presents as "the host provisioned
but I can't reach it".

Without a Tailscale credential the panel **refuses to provision**. Creating a
VM that runs an unauthenticated app and cannot join the private network is the
one outcome worth blocking outright (D-34).

## Bootstrap

`renderHostCloudInit(spec)` in a new `packages/sandbox/src/template-host.ts`:

1. `apt-get install` docker + compose plugin
2. install Tailscale, `tailscale up --authkey=… --hostname=<name> --ssh`
3. read back `tailscale ip -4` — this is what the app binds to
4. write `/opt/nexus-host/docker-compose.yml` and `.env`
   (`NEXUX_BIND=<tailscale-ip>`, `NEXUX_WEB_ORIGIN=http://<tailscale-ip>:3030`)
5. `docker compose pull && docker compose up -d`
6. `docker compose exec -T ollama ollama pull nomic-embed-text` (optional,
   toggled — it is the slowest step and not everyone wants embeddings)
7. write a completion marker with the resolved Tailscale IP

The marker matters: the panel needs a definite "done", not a guess from
uptime. Same shape as the sandbox's `/var/log/nexux-bootstrap.log` + completion
check, so the existing polling pattern applies.

**Size limits.** `prepareWorkDir` already rejects an EC2 `user_data` over 16 KB
and throws with a readable message. The host cloud-init is *shorter* than the
sandbox one (no repos, no env fan-out, no agent CLIs), so it fits — but the
test must assert it, not assume it.

**The compose file is generated, not fetched.** It is a rendered artifact of
the same shape as the repo's `docker-compose.yml`, so a host created today does
not silently change behaviour when that file is edited tomorrow.

## Status is asynchronous

Provisioning takes minutes. The lifecycle is:

```
pending → provisioning (terraform apply)
        → bootstrapping (cloud-init: docker, tailscale, pull, up)
        → running (marker present, /api/health answers over Tailscale)
        → error (any step failed; `error` holds why)
```

`bootstrapping → running` is confirmed by reading the marker over SSH, exactly
as `localBootstrapComplete` does today. The panel polls; the log streams into
`NexusHost.log` so a failure is readable without SSH.

A host that never reaches `running` still exists and still costs money, so the
row stays visible with its error and a working **Destroy** — the failure mode
that must never strand a billed VM.

## API

| Route | Purpose |
|---|---|
| `GET /api/hosts` | list, with reconciliation of obviously-stale rows |
| `POST /api/hosts` | validate → provision → bootstrap (returns immediately, status polls) |
| `GET /api/hosts/[hostId]` | one host + status |
| `GET /api/hosts/[hostId]/log` | bootstrap log, `?follow` like the sandbox log route |
| `DELETE /api/hosts/[hostId]` | terraform destroy, then mark `destroyed` |
| `GET /api/hosts/readiness` | terraform present? cloud credential? tailscale credential? image reachable? |

`readiness` is what lets the form explain *before* the user fills it in why the
Create button is disabled — the same service the sandbox tab already provides.

## UI

A **Nexus hosts** card in Settings, above Backup & migration (create the
machine, then move your configuration into it).

- Empty state: what this does, what it costs, and the readiness checklist with
  a link to whatever is missing.
- Form: provider, credential, region, size, disk image, Tailscale credential,
  "pull the embedding model" toggle, image reference (prefilled).
- While provisioning: status pill + streaming log.
- Once running: the Tailscale address as a link, a copy button, and a hint to
  open Backup & migration next.
- Destroy behind a confirm naming the host — it is irreversible and the VM's
  data volume goes with it.

The card must state plainly that **the app on that host has no
authentication** and is reachable only from the tailnet (D-34). The panel is
the moment that constraint stops being theoretical.

## Cost

The user is spending real money. So:

- the size selector shows the provider's price where known;
- the confirm step names the instance size;
- a failed bootstrap keeps Destroy prominent rather than hiding the row.

## Tests

- `renderHostCloudInit` — idempotent re-run, Tailscale key never echoed into
  the log, compose written before `up`, marker written last.
- EC2 16 KB `user_data` bound asserted, not assumed.
- Injection safety on `name` / `imageRef` (they reach a shell), same discipline
  as `safeSlug` and the terminal's strict charsets.
- Route tests: refuses without a Tailscale credential; refuses an unreachable
  image; `DELETE` on a half-provisioned host still runs destroy.
- Status transitions, including bootstrap failure → `error` with the log
  retained.

## Open questions

1. ~~**Whose GHCR package?**~~ **Resolved** (2026-08-02): the git remote is
   `ideascoldigital/nexus`, so the image is
   `ghcr.io/ideascoldigital/nexus`, published by
   `.github/workflows/release-image.yml` on pushes to `main` (`edge`) and on
   release tags (`1.2.3`, `1.2`, `latest`). `hostImage` defaults to
   `ghcr.io/ideascoldigital/nexus:latest`.

   Still outstanding: **the package is private until someone makes it
   public.** The readiness check must therefore verify the reference is
   actually *pullable*, not merely well-formed — a private package with no
   token fails at `docker pull` on a VM that has already been billed.
2. **Does the host need to know it is a host?** A `NEXUX_ROLE=host` env var
   would let the app hide the panel on the VM itself (creating hosts from a
   host is confusing and probably unwanted). Cheap; worth it.
3. **AWS parity.** The Civo path is straightforward. AWS needs a VPC/subnet
   decision the sandbox template already makes — reuse it, but the default
   security group should be even tighter here (no inbound at all once
   Tailscale SSH is on).

## State

**Prerequisite done** (2026-08-02): `.github/workflows/release-image.yml`
publishes the multi-arch server image to `ghcr.io/ideascoldigital/nexus` and
smoke-tests it before anyone can provision a VM around it — the published image
must boot, answer `/api/health`, report `terraform: true` through the app's own
readiness probe, and keep its database on the volume.

**Model + bootstrap done** (2026-08-02): migration
`20260802140000_nexus_host` and the `NexusHost` model, plus
`packages/sandbox/src/template-host.ts` (`renderHostCloudInit`,
`renderHostCompose`, `parseHostMarker`, `safeHostName`, `isValidImageRef`).
25 tests, and the generated script was executed end to end in an `ubuntu:22.04`
container with the network calls stubbed: marker written with the resolved
address, `.env` bound to it, **zero occurrences of the auth key in the log**.
The no-address path was exercised separately — it exits non-zero, writes no
marker and never starts the stack, so a host that cannot join the tailnet stays
down rather than coming up bound to a public interface.

Two implementation notes worth carrying forward:

- `shq` moved from `template.ts` to `slug.ts`. Both bootstraps interpolate
  user-supplied values into generated shell, and one escaping implementation
  means a fix cannot land on only one of them. Covered by `slug.test.ts`, which
  runs the quoted output through a real bash rather than regex-matching it.
- `safeHostName` is stricter than `safeSlug` and deliberately separate:
  `safeSlug` names a checkout *directory* (dots and underscores are fine),
  while a host name becomes a DNS label and a Tailscale MagicDNS name (63
  chars, no trailing hyphen after truncation).

**Routes + UI done** (2026-08-02): `apps/web/src/lib/host-manager.ts`,
`/api/hosts` (list/create), `/api/hosts/[hostId]` (detail/destroy),
`/api/hosts/readiness`, `services/hosts.ts`, and the **Nexus hosts** card at the
top of the Backup & migration tab — create the machine, then move configuration
onto it. 13 route tests; verified in the browser against the live install.

Implementation notes:

- `prepareWorkDir` / `applySandbox` gained an optional `cloudInit` override.
  A host provisions through the same Terraform module but becomes something
  else entirely, so it supplies its own bootstrap rather than threading host
  concepts through `SandboxSpec`.
- `tailscale` joined the `CloudCredential` provider set — the type, the zod
  schema on `POST /api/credentials`, and the picker. It stores `{ token }` like
  the other single-token providers; `resolveTailscaleKey` reads either
  `authKey` or `token`.
- Open question 2 resolved: the generated compose sets `NEXUX_ROLE=host`, and
  the panel replaces itself with an explanatory card when it sees it, so a host
  cannot create further hosts.

**Remaining:** open question 3 (AWS parity — the security group should be
tighter than a sandbox's once Tailscale SSH is on). Region and size lists are
hardcoded per provider in `services/hosts.ts`; they should eventually come from
the provider API.
