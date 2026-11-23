/**
 * Native self-update — download the right release asset and install it.
 *
 * Ported from knock's installer (scripts/install-app.sh there), with one
 * structural difference: knock's UI invokes a Tauri command that opens a
 * Terminal running `curl | bash`, because its repo is public and its frontend
 * has the Tauri API. Nexus's UI is a plain web app served by the local node
 * sidecar, and the repo is private — so the sidecar does the whole job
 * itself: fetch the release with a GitHub token, download the platform asset,
 * and install it in-process. No Terminal, no raw-URL scripts, works private.
 *
 * Per platform, mirroring knock's choices:
 *  - macOS: mount the DMG, replace /Applications/Nexus.app, strip the
 *    Gatekeeper quarantine (unsigned bundle; no sudo — the copy is ours).
 *  - Windows: launch the NSIS setup exe; its GUI handles the rest.
 *  - Linux: AppImage into ~/.local/bin (no sudo). deb/rpm need root, so they
 *    stay manual.
 */

import { execFile, spawn } from "child_process";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { promisify } from "util";

import { githubToken } from "@/lib/github-token";
import { REPO } from "@/lib/repo";

const execFileP = promisify(execFile);

export type ReleaseAsset = { name: string; url: string; apiUrl: string };

/**
 * Which asset fits this machine. Pure so it is testable against the real
 * asset lists a release carries. Returns null when the release has nothing
 * for this platform — the caller reports, never guesses.
 */
export function pickAsset(
  names: string[],
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const find = (re: RegExp) => names.find((n) => re.test(n)) ?? null;
  if (platform === "darwin") {
    return arch === "arm64"
      ? find(/aarch64\.dmg$/i)
      : find(/(x64|x86_64)\.dmg$/i);
  }
  if (platform === "win32") {
    return find(/-setup\.exe$/i) ?? find(/\.msi$/i);
  }
  if (platform === "linux") {
    return arch === "arm64"
      ? find(/aarch64\.AppImage$/i)
      : find(/(amd64|x86_64)\.AppImage$/i);
  }
  return null;
}

/** The newest release and its assets, via the GitHub API (token-aware). */
export async function latestReleaseAssets(): Promise<{
  tag: string;
  assets: ReleaseAsset[];
}> {
  const token = await githubToken();
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`GitHub releases/latest answered ${res.status}`);
  const body = (await res.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string; url: string }>;
  };
  return {
    tag: body.tag_name,
    assets: body.assets.map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      apiUrl: a.url,
    })),
  };
}

/**
 * Download one release asset to a temp dir and return its path. On a private
 * repo the browser_download_url 404s without a session, so the asset API URL
 * with Accept: octet-stream (which 302s to a signed S3 URL) is the one that
 * works both private and public.
 */
export async function downloadAsset(asset: ReleaseAsset): Promise<string> {
  const token = await githubToken();
  const res = await fetch(asset.apiUrl, {
    headers: {
      Accept: "application/octet-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "follow",
    cache: "no-store",
  });
  if (!res.ok || !res.body) {
    throw new Error(`asset download answered ${res.status}`);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexux-update-"));
  // basename: the name comes from the release, and must not choose a path.
  const dest = path.join(dir, path.basename(asset.name));
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    createWriteStream(dest),
  );
  return dest;
}

/**
 * How to launch a downloaded Windows installer. Directly, never through
 * `cmd /c start`, which re-parses the path and would run whatever follows an
 * `&` in it. An .msi (pickAsset's fallback) is not executable on its own;
 * msiexec opens it. Pure so it is testable off Windows.
 */
export function windowsInstallerCommand(file: string): string[] {
  return file.toLowerCase().endsWith(".msi") ? ["msiexec", "/i", file] : [file];
}

/**
 * Install a downloaded asset. Returns a user-facing message; throws with a
 * user-facing message on failure. `platform` is a parameter for tests only.
 */
export async function installAsset(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (platform === "darwin") return installDmg(file);
  if (platform === "win32") {
    // Detached so the NSIS window outlives this request — it will ask the
    // user to close the running app itself.
    const [bin, ...args] = windowsInstallerCommand(file);
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
    return "Installer launched — follow its steps, then relaunch Nexus.";
  }
  if (platform === "linux") return installAppImage(file);
  throw new Error(`unsupported platform: ${platform}`);
}

// knock's install-app.sh macOS section, in node: mount, replace, strip
// quarantine, detach. No sudo anywhere — the copy is owned by this user, so
// plain xattr works; knock only reaches for sudo because its script may run
// as a different user than the eventual owner.
async function installDmg(dmg: string): Promise<string> {
  const { stdout } = await execFileP("hdiutil", [
    "attach",
    "-nobrowse",
    "-readonly",
    dmg,
  ]);
  const mount = stdout
    .split("\n")
    .map((l) => l.split("\t").pop()?.trim() ?? "")
    .find((p) => p.startsWith("/Volumes/"));
  if (!mount) throw new Error("failed to mount the update DMG");
  try {
    const entries = await fs.readdir(mount);
    const app = entries.find((e) => e.endsWith(".app"));
    if (!app) throw new Error("no .app inside the update DMG");
    const dest = path.join("/Applications", app);
    await fs.rm(dest, { recursive: true, force: true });
    // ditto preserves the bundle exactly (resource forks, symlinks, perms).
    await execFileP("ditto", [path.join(mount, app), dest]);
    await execFileP("xattr", ["-dr", "com.apple.quarantine", dest]).catch(
      () => {
        // Best effort — worst case the first launch needs right-click → Open.
      },
    );
    if (app === "Nexus.app") {
      // The product rename (Nexux → Nexus) means a machine that updates keeps
      // the superseded bundle beside the new one; installing Nexus.app retires
      // it. force: true — nothing to do on installs that never had it.
      await fs
        .rm(path.join("/Applications", "Nexux.app"), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
    }
    return `Installed ${app} — quit and relaunch Nexus to finish.`;
  } finally {
    await execFileP("hdiutil", ["detach", "-quiet", mount]).catch(() => {});
  }
}

/**
 * Where the AppImage lands. An install that already has the legacy
 * `Nexux.AppImage` keeps updating that file — desktop launchers and shell
 * aliases point at the path, and a renamed copy beside it would leave them
 * running the old build forever. Fresh installs get the current name.
 */
export function appImageDest(dir: string, existing: string[]): string {
  const name = existing.includes("Nexux.AppImage")
    ? "Nexux.AppImage"
    : "Nexus.AppImage";
  return path.join(dir, name);
}

// knock's Linux AppImage path: per-user bin dir, executable bit, no sudo.
async function installAppImage(file: string): Promise<string> {
  const dir = path.join(os.homedir(), ".local", "bin");
  await fs.mkdir(dir, { recursive: true });
  const dest = appImageDest(dir, await fs.readdir(dir));
  await fs.copyFile(file, dest);
  await fs.chmod(dest, 0o755);
  return `Installed ${dest} — quit and relaunch Nexus to finish.`;
}
