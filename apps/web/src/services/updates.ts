/**
 * Update check — client service for the statusbar. See `/api/updates`.
 */

import type { InstallResult } from "@/app/api/updates/install/route";
import type { UpdateStatus } from "@/app/api/updates/route";
import type { AutoUpdateState } from "@/lib/auto-update";

export type { AutoUpdateState, InstallResult, UpdateStatus };

/**
 * Newest published release vs. this build. Null when the check cannot be
 * answered (no release yet, GitHub down, offline) — the statusbar just hides
 * the badge; an update check must never break the app under it.
 */
export async function checkUpdates(
  /** Skip the server's 30-minute release cache — pass after an update. */
  fresh = false,
): Promise<UpdateStatus | null> {
  try {
    const res = await fetch(`/api/updates${fresh ? "?fresh=1" : ""}`);
    // 204 = no release published yet — nothing to compare against.
    if (!res.ok || res.status === 204) return null;
    return (await res.json()) as UpdateStatus;
  } catch {
    return null;
  }
}

/** Download and install the newest release — native app only. Throws to the badge. */
export async function installUpdate(): Promise<InstallResult> {
  // JSON content type: the route's cross-site guard (lib/local-request.ts).
  const res = await fetch("/api/updates/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Partial<InstallResult>;
  if (!res.ok) throw new Error(body.error || `install failed (${res.status})`);
  return body as InstallResult;
}

/**
 * What the native background auto-updater has done. Null off native (404) or
 * when the sidecar cannot be reached — the notice just stays hidden.
 */
export async function getAutoUpdateState(): Promise<AutoUpdateState | null> {
  try {
    const res = await fetch("/api/updates/auto");
    if (!res.ok) return null;
    return (await res.json()) as AutoUpdateState;
  } catch {
    return null;
  }
}

/** Quit and reopen the native app so an installed update takes effect. */
export async function restartApp(): Promise<void> {
  const res = await fetch("/api/updates/restart", {
    method: "POST",
    // The JSON content type is the route's cross-site guard — keep it.
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `restart failed (${res.status})`);
  }
}

/**
 * Open a URL in the system browser. In the native app the Tauri webview does
 * nothing with target="_blank", so the sidecar hands the URL to the OS; in a
 * browser the endpoint 404s and window.open does the job.
 */
export async function openExternal(url: string): Promise<void> {
  try {
    const res = await fetch("/api/open-url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    if (res.ok) return;
  } catch {
    // fall through to window.open
  }
  window.open(url, "_blank", "noreferrer");
}
