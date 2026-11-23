/**
 * Native auto-update — check GitHub for a newer release, download it and
 * install it in the background, then wait for the user to restart.
 *
 * The mechanics (asset pick, download, per-OS install) are lib/self-update.ts;
 * this module decides *when* to run them and remembers what happened, so the
 * UI can say "Nexus 0.3.6 installed — Restart" from any page. Installing never
 * restarts the app by itself: a bot may be mid-task, and the replaced bundle
 * takes effect on the next launch anyway (see /api/updates/restart).
 *
 * Only release builds update themselves. A bundle built from a checkout
 * (`pnpm build:native`) carries package.json's version, which lags the tags —
 * left on, the updater would replace the build you just made with an older
 * published one. CI's tag builds bake NEXUX_RELEASE_BUILD=1 via build-info.json.
 */

import fs from "fs/promises";
import path from "path";

import { isNewer } from "@/app/api/updates/route";
import { buildVersion } from "@/lib/build-version";
import {
  downloadAsset,
  installAsset,
  latestReleaseAssets,
  pickAsset,
} from "@/lib/self-update";

export type AutoUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "downloading"
  | "installed"
  | "error";

export type AutoUpdateState = {
  phase: AutoUpdatePhase;
  /** Why auto-update is off (phase "disabled"). */
  reason?: string;
  /** Version this process is running. */
  current?: string;
  /** Release being installed or already installed, e.g. "v0.3.6". */
  tag?: string;
  /** User-facing result of the last install, or the last error. */
  message?: string;
  /** Whether /api/updates/restart can relaunch on this platform. */
  canRestart?: boolean;
  checkedAt?: string;
};

const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Next bundles route handlers and instrumentation separately, so a plain
// module-level variable would be one copy per bundle — the install route and
// the background loop would each think nothing else is running. globalThis is
// the one object they share.
type Shared = {
  state: AutoUpdateState;
  running: Promise<AutoUpdateState> | null;
  started: boolean;
};
const KEY = Symbol.for("nexux.autoUpdate");
const g = globalThis as unknown as Record<symbol, Shared | undefined>;
function shared(): Shared {
  return (g[KEY] ??= { state: { phase: "idle" }, running: null, started: false });
}

export function autoUpdateState(): AutoUpdateState {
  return { ...shared().state };
}

/**
 * Why this process must not update itself in the background, or null when it
 * may. Pure over its env so the gate is testable.
 */
export function autoUpdateDisabledReason(env: Record<string, string | undefined>): string | null {
  if (env.NEXUX_NATIVE !== "1") return "not the native app";
  if (env.NEXUX_AUTO_UPDATE === "0") return "turned off (NEXUX_AUTO_UPDATE=0)";
  if (env.NEXUX_RELEASE_BUILD !== "1") {
    return "local build — only release builds update themselves";
  }
  return null;
}

/** Platforms where the restart route can relaunch the app after an install. */
export function canRelaunch(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Should a check that found `latest` install it? Not when this build already
 * is that release, and not again when that exact release is already installed
 * and only waiting for a restart.
 */
export function shouldInstall(
  current: string,
  latestTag: string,
  state: AutoUpdateState,
): boolean {
  if (!isNewer(current, latestTag)) return false;
  if (state.phase === "installed" && state.tag && !isNewer(state.tag, latestTag)) {
    return false;
  }
  return true;
}

function set(patch: AutoUpdateState) {
  shared().state = patch;
}

/**
 * Install the newest release if it is newer than this build. Shared by the
 * background loop and the statusbar's install button: concurrent callers get
 * the run already in flight instead of two downloads racing over /Applications.
 *
 * `force` is the button — the user asked, so the local-build gate does not
 * apply (the version comparison still does).
 */
export function installLatest(opts: { force?: boolean } = {}): Promise<AutoUpdateState> {
  const s = shared();
  if (s.running) return s.running;
  s.running = runInstall(opts).finally(() => {
    s.running = null;
  });
  return s.running;
}

async function runInstall({ force = false }: { force?: boolean }): Promise<AutoUpdateState> {
  const prev = shared().state;
  const canRestart = canRelaunch(process.platform);
  const reason = autoUpdateDisabledReason(process.env);
  if (reason && !force) {
    set({ phase: "disabled", reason });
    return autoUpdateState();
  }
  const current = await buildVersion();
  const checkedAt = new Date().toISOString();
  set({ ...prev, phase: prev.phase === "installed" ? "installed" : "checking", current, checkedAt });
  try {
    const { tag, assets } = await latestReleaseAssets();
    if (!shouldInstall(current, tag, prev)) {
      // Nothing new — keep an install that is waiting for its restart.
      set(prev.phase === "installed" ? { ...prev, checkedAt } : { phase: "idle", current, checkedAt });
      return autoUpdateState();
    }
    const name = pickAsset(
      assets.map((a) => a.name),
      process.platform,
      process.arch,
    );
    const asset = assets.find((a) => a.name === name);
    if (!asset) {
      throw new Error(`release ${tag} has no asset for ${process.platform}/${process.arch}`);
    }
    set({ phase: "downloading", current, tag, checkedAt });
    console.log(`[auto-update] downloading ${asset.name}`);
    const file = await downloadAsset(asset);
    const message = await installAsset(file);
    if (process.platform !== "win32") {
      await fs.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
    }
    console.log(`[auto-update] ${message}`);
    set({ phase: "installed", current, tag, message, canRestart, checkedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-update] failed: ${message}`);
    set({ phase: "error", current, message, checkedAt });
  }
  return autoUpdateState();
}

/** Start the background loop: one check shortly after boot, then every 6h. */
export function startAutoUpdater(): void {
  const s = shared();
  if (s.started) return;
  s.started = true;
  const reason = autoUpdateDisabledReason(process.env);
  if (reason) {
    set({ phase: "disabled", reason });
    console.log(`[auto-update] off: ${reason}`);
    return;
  }
  const tick = () => void installLatest();
  // Not at boot: the first minute belongs to migrations, the vault and the
  // window coming up, and a 200 MB download competes with all of it.
  setTimeout(tick, FIRST_CHECK_DELAY_MS).unref();
  setInterval(tick, CHECK_INTERVAL_MS).unref();
  console.log("[auto-update] on — first check in 60s, then every 6h");
}
