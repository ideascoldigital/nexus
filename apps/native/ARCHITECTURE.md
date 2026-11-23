# @nexux/native — Architecture

> Tauri v2 desktop shell. No UI of its own — bundles the built `@nexux/web` Next.js server as a Node **sidecar** and points a native webview at it.

## How it works

- **Window:** single `main` window ("Nexux", 1400×900, min 900×600) + native View menu with webview zoom (`Cmd+=/-/0`, clamped 0.5–3.0).
- **Sidecar (production):** spawns bundled Node (`externalBin: binaries/node`) running `sidecar/start.js` on port **3030** (terminal **3032**). Env: `NEXUX_MODE=local`, `DATABASE_URL=file:$HOME/.nexux/nexux.db`, `NEXUX_DATA_DIR`, `NEXUX_MIGRATIONS_DIR` (Prisma migrations from `sidecar/prisma/migrations`).
- **Startup:** the window opens on the bundled placeholder (`frontendDist`), *not* on the sidecar. `lib.rs` refuses to spawn if 3030 is already taken — the readiness probe only knows "something answers", so on a busy port it would render whoever owns it (a second install, an orphaned sidecar). It then polls the port off the main thread while watching for the child dying, and navigates to `http://127.0.0.1:3030` once ready. Every failure path — port taken, sidecar exited, timeout — writes to `~/.nexux/native.log` *and* onto the placeholder via `window.__nexuxStatus`.
- **Shutdown:** `SidecarChild` kills the Node process on `RunEvent::Exit`. On Windows the child is *also* assigned to a `KILL_ON_JOB_CLOSE` job object, because no handler runs on `TerminateProcess` (Task Manager, crash, installer) and a surviving sidecar holds port 3030 plus a file lock on its own `node_modules` — which makes the next install fail mid-copy (D-40).
- **Dev mode:** no sidecar; `beforeDevCommand` runs `@nexux/web dev:native` on :3100 (terminal :3102) — the dev server itself, so it shares `pnpm dev`'s database and hot-reloads. It cannot run alongside `pnpm dev`: Next refuses a second dev server in one directory, and the instance lock would refuse a second server on one database anyway.
- **Installed app on another database:** `~/.nexux/native.json` (`databasePath`, `dataDir`; `~/` expands, relative paths refused) — see `src-tauri/src/native_config.rs`. The log and the file itself always stay in `~/.nexux`. Editable from Settings → Desktop app (`apps/web/src/lib/desktop-config.ts`, same rules); the sidecar gets `NEXUX_SHELL=native` so that page knows to say "reopen Nexus" rather than "applies next launch".

## Key files

| File | Role |
|---|---|
| `src-tauri/src/lib.rs` | Sidecar lifecycle, port wait, zoom menu, clean shutdown |
| `src-tauri/tauri.conf.json` | Window, sidecar binaries/resources, `devUrl` :3100, bundle `targets: all` |
| `scripts/build-sidecar.ts` | Builds + **slims** the sidecar bundle (see below) |
| `tests/parity.test.ts` | Native ↔ web drift guards |

## Sidecar build

`build-sidecar.ts` is a size-critical packaging step, not a copy:

- Copies `.next/` but skips `cache`, `dev` and `standalone` — build/dev-only, ~1.4 GB of bloat that `next start` never reads.
- Prunes `node_modules`, including non-target Prisma query compilers: the client ships one ~14 MB engine set per database, and Nexux is sqlite-only (`PRISMA_KEEP_DB`).
- Copies `packages/db/prisma/migrations` → `sidecar/prisma/migrations` (what `NEXUX_MIGRATIONS_DIR` points at).
- Generates `sidecar/start.js`, the tiny `next start` launcher the Rust side spawns — and **deletes the deployed `next.config.*`**. `start.js` feeds Next the config it already resolved at build time (`.next/required-server-files.json`, via `__NEXT_PRIVATE_STANDALONE_CONFIG`, exactly as Next's own standalone `server.js` does). Reading `next.config.ts` at boot would make Next transpile it with SWC, and since every `@next/swc-*` is pruned above it installs `next-swc-fallback` *into its own install directory* — fatal under `C:\Program Files` (D-39).
- Strips `.env*` from the deployed sidecar. `pnpm deploy` copies `apps/web/.env`, so a locally produced installer would otherwise ship the build machine's secrets — and *use* them, since `@next/env` only skips keys already in `process.env` and `lib.rs` passes only `PORT`, `HOSTNAME`, `NEXUX_*` and `DATABASE_URL`. All runtime configuration comes from the environment `lib.rs` hands the process.
- Sets `NEXUX_BUILD_TARGET` so `apps/web/next.config.ts` enables standalone output.
- Asserts the Next that built `.next/` is the Next in `sidecar/node_modules`. They can differ: `pnpm deploy --legacy` re-resolves ranges and ignores the lockfile, so a `^` on `next` ships a runtime newer than the bundle it serves. `next` is pinned exactly in `apps/web/package.json`; this fails the build if that ever stops holding (D-39).

## Parity guards

The native app mirrors web config through duplicated literals that no compiler checks across the boundary, so `tests/parity.test.ts` pins each pair: version agreement (root/web/native/`tauri.conf.json`/`Cargo.toml`), sidecar port 3030 across `lib.rs`/window url/`start.js`, dev port between `beforeDevCommand` and `devUrl`, the `NEXUX_BUILD_TARGET` flag, the Prisma keep-list vs the schema's datasource provider, declared vs generated capabilities, and the two sidecar runtime couplings from D-39 (an exact `next` pin, and `start.js` pinning the build-time config). Note these **string-match Rust source** — e.g. the terminal-port test asserts `lib.rs` still contains the literal `.env("NEXUX_TERMINAL_PORT", SIDECAR_TERMINAL_PORT.to_string())`, so a harmless refactor of that line fails the test and the assertion message is the fix instruction.

## State & data

No native state beyond two mutexes (`SidecarChild`, `ZoomLevel`). All data lives in the web app's SQLite at `~/.nexux/nexux.db`. Webview ↔ sidecar via HTTP/WS on localhost — no Tauri IPC commands.

## Commands

- `pnpm dev:native` — Tauri dev against :3100.
- `pnpm build:native` — `tauri:build` → `scripts/build-app.ts`, which wraps
  `tauri build` (runs sidecar build first) and finishes a DMG that
  `bundle_dmg.sh` abandoned while unmounting. `tauri:build:raw` skips the
  wrapper; `tauri:build --finish-dmg` only recovers, without rebuilding.

## Updates

Release builds update themselves (D-93). The sidecar's `lib/auto-update.ts` checks GitHub's latest release a minute after boot and every 6h, installs a newer one with `lib/self-update.ts` (macOS: replace the bundle in /Applications; Linux: AppImage in `~/.local/bin`; Windows: NSIS installer), and the root-layout notice offers Restart → `/api/updates/restart` → `lib/relaunch.ts` (detached script: quit by bundle id, wait for this shell's pid, reopen). The gate is `build-info.json`'s `release` flag, which is true only for CI tag builds; `start.js` turns it into `NEXUX_RELEASE_BUILD=1`. `NEXUX_AUTO_UPDATE=0` disables it.

Rust backend uses `tauri-plugin-shell` + `tauri-plugin-opener`. Icons bundled for macOS/iOS/Android/Windows.
