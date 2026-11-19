# Spec 23 — Embedded browser: testing an app from inside its own network

Status: **shipped** (2026-09-12, D-69) and **verified end to end on a local
Docker sandbox** (2026-09-18, D-70) — bootstrap, model, manager, routes and the
Browser panel. The idle TTL and the CDP screenshot route remain open; see
Remaining at the end.

## Goal

Test a running sandbox app by hand — click through it, fill forms, watch the
network tab — without any of it depending on a public hostname.

The case that motivates this is two services: a front end and a back end. The
front holds an `API_URL` pointing at the back. Today each process gets its
**own** Cloudflare quick tunnel (`sandbox-process-manager.ts`, one
`cloudflared` per `SandboxProcess`), so the two arrive on unrelated random
hostnames and the front's `API_URL` — whatever it says — is wrong from the
viewer's browser. Rewriting it to the back's tunnel URL does not fix it
either: the URL is regenerated on every start, and a front that bakes its env
at build time is stale before it boots.

## Why a tunnel cannot fix this

The problem is not reachability, it is **identity**. A tunnel gives one port a
public name; a multi-service app needs the *relationships between* its ports
preserved. Chasing it with tunnels means rewriting each service's config to
point at hostnames that change per start, plus CORS on two unrelated origins,
plus cookies that are now cross-site, plus every dev server rejecting a `Host`
it does not recognize — which is already why the preview script pins
`--http-host-header localhost:<port>` ([agent-core.ts:761](../apps/web/src/lib/agent-core.ts:761)).
Each is a patch on the same wrong premise.

Inside the sandbox none of it exists. `localhost:3000` and `localhost:8000`
are both there, the front's `API_URL` is already correct, origins match, and
no `Host` header is rewritten. So: **move the browser to where the app is**,
instead of moving the app to where the browser is.

## Shape

A browser session is one more supervised process on the sandbox, following
the model `SandboxProcess` established — a stable key, a recorded PID, a log,
started and stopped over `execRemote`.

```
Xvfb :99                    virtual display
  └── chromium              already installed (see below)
        └── x11vnc :5900    bound to 127.0.0.1
              └── websockify :6080   VNC → WebSocket, for noVNC
```

The dashboard reaches `:6080` over an **SSH port-forward from the host**, not
a public tunnel. See Security.

### Chromium is already there

`installAgentBrowser` installs Playwright's Chromium and links it at
`/usr/local/bin/google-chrome` ([template.ts:1156](../packages/sandbox/src/template.ts:1156)),
because agents need a browser for screenshots. This spec adds no browser —
only `xvfb`, `x11vnc` and `websockify`, through the same conditional-section
pattern `installCloudflared` uses, gated on a new `installBrowserSession`.

That also settles the CDP half for free: the same Chromium runs with
`--remote-debugging-port=9222` bound to `127.0.0.1`, so a session serves both
the human (VNC) and programmatic drive (CDP) from one process. Agents get
`navigate` and `screenshot` against the app *as the user sees it*, which is
what `renderScreenshotSection` has wanted all along.

## Data model

One model, mirroring `SandboxProcess`'s lifecycle vocabulary:

```prisma
model BrowserSession {
  id         String   @id @default(cuid())
  sandboxId  String
  status     String   @default("stopped") // stopped | starting | running | error
  pid        Int?     // the supervisor script's PID; kills are by PID, never pattern
  display    String   @default(":99")
  vncPort    Int      @default(5900)
  wsPort     Int      @default(6080)
  cdpPort    Int      @default(9222)
  token      String   // VNC password, generated per session, never logged
  width      Int      @default(1440)
  height     Int      @default(900)
  error      String?
  startedAt  DateTime?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  sandbox Sandbox @relation(fields: [sandboxId], references: [id], onDelete: Cascade)

  @@unique([sandboxId])
  @@index([sandboxId])
}
```

One session per sandbox (`@@unique`): a second browser would need a second
display, a second port trio and its own supervision, to solve a problem
nobody has. Restarting replaces.

Migration `packages/db/prisma/migrations/<ts>_browser_session`.

## Security

This is the part that must not be got wrong, because the object being exposed
is a browser with unrestricted access to `localhost` on a machine holding the
project's checkouts, its `.env` files and its git credentials.

**No public tunnel.** A quick tunnel URL is unguessable but public, and
anyone who obtains it drives that browser. The dashboard already runs on the
user's own machine (local-first), and the host already holds the sandbox
keypair and opens SSH sessions to it — so the transport is an **SSH
port-forward** (`-L <localPort>:127.0.0.1:6080`), reusing
`sandboxPrivateKeyPath` and the same address resolution as
`sandboxTarget`. Nothing on the sandbox binds to a public interface:
`x11vnc -localhost`, `websockify` on `127.0.0.1`, CDP on
`--remote-debugging-address=127.0.0.1`.

CDP deserves the explicit note: an open `:9222` on a public interface is
remote code execution with extra steps — it can read any origin the browser
can, including `file://`.

**The VNC password is per session**, generated host-side, passed via
`x11vnc -passwd`, and never echoed. Spec 19 already set this bar for the
Tailscale auth key ("zero occurrences of the auth key in the log") and the
test here asserts the same.

**Local sandboxes** (`provider === "local"`) have no sshd — `sandboxTarget`
returns a container instead. Those forward with `docker port` / a published
port on loopback, never `-p 0.0.0.0`.

**Idle TTL.** A forgotten session is a live browser on a billed VM. The
session stops after a configurable idle period, and the row keeps a working
Stop the way a failed host row keeps a working Destroy (spec 19).

## API

Mirrors the process routes, under the sandbox that owns it:

| Route | Purpose |
|---|---|
| `POST /api/projects/[projectId]/sandboxes/[sandboxId]/browser` | start (or restart) the session; returns the local forwarded URL |
| `DELETE …/browser` | stop the session, the forward, and Chromium |
| `GET …/browser` | current status, for polling |
| `GET …/browser/log` | the supervisor log, like the process log route |
| `POST …/browser/navigate` | CDP `Page.navigate` — jump straight to `localhost:3000` |
| `POST …/browser/screenshot` | CDP capture; what tasks reuse |

`maxDuration = 300`, as the process route has: Xvfb plus a cold Chromium is
slow, and the existing routes already chose this bound.

## UI

A **Browser** tab beside Processes in the sandbox sheet
(`components/projects/sandbox-processes.tsx` is the neighbour and the model).

- noVNC in an `<iframe>`, pointed at the locally forwarded port.
- A URL bar whose shortcuts are the stack's own ports — `nodePorts()`
  ([node-runtime.ts:45](../apps/web/src/lib/stack/node-runtime.ts:45)) already
  computes them, including the ones hidden inside `pnpm dev`. This is the
  whole point made visible: one click to `localhost:3000`, and the app's own
  `API_URL` resolves.
- Status pill + log, same vocabulary as a process row.
- Stop is prominent, including on `error`.

noVNC ships as a static asset under `apps/web/public/novnc/` rather than a
CDN: the app must work offline (local-first), and a pinned vendored copy is
also one fewer third-party origin able to see the session.

## What this does not replace

Per-process tunnels stay, and stay useful — for **sharing** a running app with
someone who is not at this machine. What changes is the default: for testing
it yourself, the embedded browser is strictly better, so the tunnel becomes
opt-in rather than automatic.

## Alternatives considered

**Browserbase (and hosted browser infrastructure generally).** The request
that started this spec named Browserbase as the experience to aim for, so it
deserves an explicit answer rather than a silent omission.

It does not fit, for the same reason tunnels do not. Browserbase runs the
browser **in its cloud**, so a front end asking for `localhost:8000` resolves
that against Browserbase's container, where the back end does not exist. The
identity problem is relocated, not solved: reaching the services would still
mean exposing both publicly, which is the thing being avoided. Closing that
gap means putting a hosted browser inside this network — Tailscale in their
container, or a reverse proxy — which is not what the product sells.

Three further reasons, any one of which would be enough:

- **Local-first** (CLAUDE.md: no cloud requirement). A paid API key would
  become the first mandatory cloud dependency of a core workflow.
- **The browser is already installed.** Every sandbox with
  `installAgentBrowser` has Chromium, in the right network, unused for this.
- **What it sells is not what is missing.** Hosted browser infra is for scale
  — pools, concurrency, captchas, IP rotation — aimed at scraping and agent
  fleets. This needs one browser, inside one network, driven by hand.

Where it *would* fit is running browser agents in parallel against **public**
sites. That is a different problem, and this spec does not foreclose it.

## Tests

- Bootstrap: `renderBrowserSection` is idempotent on re-run, the VNC password
  appears **zero times** in the generated log output, every listener binds
  loopback, and the section is absent when `installBrowserSession` is false.
- Injection safety on anything reaching the shell (dimensions, display, token)
  — `shq` from `slug.ts`, the discipline spec 19 established.
- Kills are by recorded PID, never by pattern: the supervisor's own command
  line contains what it launches, so `pkill -f` would match itself. The
  comment at the top of `sandbox-process-manager.ts` is about exactly this bug.
- Status reconciliation: a session whose PID is gone reads `stopped`; a
  sandbox that cannot be reached keeps its stored status (`alive === null` is
  not `false` — `reconcileRowState`'s rule).
- Route tests: refuses on an unreachable sandbox; `DELETE` on a half-started
  session still tears the forward down; local vs cloud both resolve a target.
- CDP `navigate` rejects non-`localhost` targets by default, so the session
  cannot be steered at arbitrary origins by a caller that is not the user.

## Remaining

- **Idle TTL.** A forgotten session is a live browser on a billed VM. The row
  and the forward survive until stopped by hand; nothing reaps an idle one yet.
- **`POST …/browser/screenshot`.** Specced and unbuilt. `navigate` shipped
  because the address bar is unusable without it; screenshots are what would
  let task runs reuse the session, and `renderScreenshotSection` is where they
  would land.
- ~~**Local sandboxes.**~~ Done (D-70). `docker run` publishes the bridge on an
  ephemeral loopback port (`-p 127.0.0.1::6080` — ephemeral because a fixed
  6080 collides as soon as a second local sandbox runs), `browserWsPort` reads
  it back with `docker port`, and `toView` serves `localUrl` from it in place
  of a forward. One deliberate loosening: docker forwards a published port to
  the container's own interface, which a loopback-only listener never answers,
  so websockify binds `0.0.0.0` under an explicit `wsAllInterfaces` flag set
  only for `provider === "local"`. There the boundary is docker's `127.0.0.1::`
  binding, which never leaves the host's loopback. VNC and CDP are untouched.

## Open questions

1. **Where does the SSH forward live?** `instrumentation.ts` owns process
   lifecycle today (terminal server, poller, scheduler) and a forward is the
   same kind of object. But it is *per session*, not per boot — likely a small
   supervisor in `lib/`, with `instrumentation.ts` only reaping orphans at
   startup the way `recoverOrphanSandboxes` already does.
2. **Does the browser need the app's `.env`?** A front reading
   `NEXT_PUBLIC_*` at build time is already correct inside the sandbox. A
   front reading it at *runtime from the browser* is not, and no browser
   placement fixes that — worth naming so it is not mistaken for a bug here.
3. **Resolution and DPI.** 1440x900 fits most dashboard panes; mobile
   viewport testing wants presets, which is a UI question, not a transport
   one.
4. **Does a session survive a sandbox stop/start?** The PID does not. Cheapest
   correct answer is that it does not either, and the row reconciles to
   `stopped` — consistent with how processes behave today.
