# @nexux/terminal — Architecture

> WebSocket terminal server: node-pty shells over WS, including into-sandbox sessions (SSH for cloud, `docker exec` for local). The *human* interactive surface (contrast with `@nexux/harness`, the brain-facing one).

## Key files

| File | Role |
|---|---|
| `src/terminal-server.ts` | `startTerminalServer()`: HTTP + WS server. Spawns a local `pty` shell (which one comes from the `shell` query param — see `shells.ts`), an `ssh` session when `cwd` is `ssh://user@host/path` (strict regex, sandbox key, `IdentitiesOnly`, flags built by the exported pure `sshLaunchArgs` — see "Remote sessions that do not answer"), or `docker exec -it` when it is `docker://[endpointId@]container/path` (local sandboxes, which have no public IP). An endpoint id (spec 26) is resolved to its `ssh://` host by the injected `resolveDockerHost` — the web app passes one backed by the database; the standalone CLI has none, so remote targets close with a message rather than fall back to this machine's daemon. The browser never sends a host. Both remote schemes use strict charsets so a name can't pose as a flag or escape the shell quoting; anything else falls through to the local shell. Resize messages, ping/pong heartbeat. No module-level side effects — callable in-process. CLI entry when run directly |
| `src/shells.ts` | Which shells this machine can run, and how to launch each. POSIX has one answer (`$SHELL` → zsh → bash → sh); Windows has several genuinely different ones — `cmd`, `powershell`, `pwsh`, and one id per WSL distro (`wsl:Ubuntu-24.04`) — so the choice is **per session**, not per machine. Also owns `toWslPath` |
| `scripts/smoke-shells.mts` | Manual check: opens one session per detected shell and reports whether each landed in the requested directory. Not in the suite — it needs the machine's real shells to mean anything |
| `src/sidecar-server.ts` | Minimal HTTP server with `/health` on its own port 3001 — self-described "Fase 0 stub", rejects WS. Unrelated to the terminal server |
| `src/types.ts` | `ProcessStatus`, `GlobalEvent` (Fase 0 stub) |

## Public API

`index.ts` re-exports `./types` plus the shell helpers (`listShells`, `defaultShellId`, `parseShellId`, `spawnPlan`, `toWslPath`); subpaths expose `./terminal-server`, `./sidecar-server`, `./types`. The index deliberately does **not** pull `terminal-server`, so `apps/web`'s `/api/terminal/shells` route can import it without dragging `node-pty` into a route bundle.

## Choosing a shell

A session names its shell with the `shell` query param; an id this machine cannot run resolves to the default and the session says so in-band rather than failing to spawn. `apps/web` sends the id stored on the terminal pane, falling back to the workspace default in `Settings` (key `terminal_default_shell`) — the pty server itself never reads the database.

WSL is the awkward one: node-pty's `cwd` must be a **Windows** directory, so the Linux working directory is a `cd` inside the distro instead, and `toWslPath` translates what the UI stored (`E:\workspace\x` → `/mnt/e/workspace/x`, `\\wsl.localhost\<distro>\x` → `/x`). The launcher is `sh -lc`, not `bash -lc` — a distro is not obliged to have bash (`docker-desktop` is busybox) — and it `exec`s bash only when present. The `cd` tolerates a missing path (`2>/dev/null`) exactly like the ssh and docker branches, so a distro that cannot see the host's drives opens in its home directory instead of dying.

## Remote sessions that do not answer

A sandbox under load accepts the TCP connection and then fails to send its SSH banner in time. OpenSSH's default for that is **120 seconds**, during which the pane is blank — which reads as "terminals are broken", not "that box is busy". `sshLaunchArgs` sets `ConnectTimeout=15` (OpenSSH applies it to the banner exchange, not just the TCP connect, which is what makes it the right knob) plus `ServerAliveInterval=15`/`CountMax=3` so a session that dies mid-flight drops in ~45s instead of waiting out TCP. `execRemote` in `@nexux/sandbox` has always passed `ConnectTimeout=15`; the terminal was the one ssh caller that did not.

The pane also says what it is doing: `[connecting to <target>…]` on the way in, and on ssh's exit code 255 a line naming the box that refused, so the failure attaches to the machine rather than to Nexux.

## Runtime

Normally started **in-process** by the Next server: `apps/web/src/instrumentation.ts` imports `./terminal-server` and calls `startTerminalServer()` on every boot (dev, `next start`, Tauri sidecar). Set `NEXUX_DISABLE_INPROC_TERMINAL=1` to skip it and run a standalone process instead.

Env: `NEXUX_TERMINAL_PORT` (default **3002**; 3032 under Tauri, 3102 in native dev), `NEXUX_WEB_ORIGIN` (CORS `Access-Control-Allow-Origin`, default `http://localhost:3000`).

Scripts: `dev:terminal`, `start:terminal`, `dev:server`, `start:server`; `postinstall` runs `scripts/fix-pty-permissions.mjs`, which restores the executable bit on node-pty's `spawn-helper` (a POSIX-only concern — it was a `chmod … || true` one-liner, which is a parse error under cmd.exe and failed `pnpm install` on Windows). Consumed by the `apps/web` xterm UI, which resolves the live port from `/api/terminal/info` and speaks the `@nexux/core` WS protocol.

## Dependencies

Internal: `@nexux/config`, `@nexux/core`. External: `node-pty`, `ws`.

## State

`terminal-server.ts` complete (SSH support, heartbeats). Sidecar + types = Fase 0 stubs awaiting Tools/MCP work.
