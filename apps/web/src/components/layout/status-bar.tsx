"use client";

// Bottom statusbar — build identity + update check, modeled on knock's.
// Version tag opens the GitHub release, @commit opens the commit, and the
// badge lights up when a newer release is published. All data comes from the
// server (/api/version, /api/updates) so browser and native show the same
// truth about the build actually running.
//
// Native extras (version.native): clicking the badge downloads and installs
// the update through the sidecar (knock's one-click updater, server-side),
// and a document-level listener reroutes every target="_blank" anchor through
// /api/open-url — the Tauri webview silently swallows _blank navigation, so
// without this no external link in the app would open anything.

import { useEffect, useState } from "react";

import { ArrowUpCircle, Check, Loader2, Sparkles } from "lucide-react";

import { OPEN_ASSISTANT_EVENT } from "@/components/assistant/assistant-panel";
import { SystemMeters } from "@/components/layout/system-meters";
import { ZoomControl } from "@/components/layout/zoom-control";
import { getVersion, type AppVersion } from "@/services/hosts";
import {
  checkUpdates,
  installUpdate,
  openExternal,
  restartApp,
  type UpdateStatus,
} from "@/services/updates";

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

type InstallPhase = "idle" | "installing" | "done" | "error";

function UpdateBadge({ native }: { native: boolean }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [phase, setPhase] = useState<InstallPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = (fresh = false) =>
      checkUpdates(fresh).then((s) => {
        if (!cancelled && s) setStatus(s);
      });
    check();
    const id = setInterval(() => void check(), UPDATE_INTERVAL_MS);
    // A self-update finishing is the one moment this answer is guaranteed
    // stale — and both caches in front of it (30 minutes server-side, six
    // hours between polls here) would otherwise keep showing "available" on a
    // host that just installed the very release being offered.
    const onBuildChanged = () => void check(true);
    window.addEventListener("nexux:build-changed", onBuildChanged);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("nexux:build-changed", onBuildChanged);
    };
  }, []);

  if (!status) return null;

  if (!status.newer) {
    return (
      <span
        className="flex items-center gap-1"
        title={`Nexus ${status.current} is up to date.`}
      >
        <Check className="size-3" aria-hidden />
        up to date
      </span>
    );
  }

  // Browser install: the badge is a link to the release page.
  if (!native) {
    return (
      <a
        href={status.url}
        target="_blank"
        rel="noreferrer"
        className="tap-target flex items-center gap-1 rounded-sm px-1 font-medium text-amber-600 hover:bg-accent dark:text-amber-500"
        title={`Update from ${status.current} to ${status.latest} — open the release to download.`}
      >
        <ArrowUpCircle className="size-3" aria-hidden />
        {status.tag} available
      </a>
    );
  }

  // Native install: the badge is the installer.
  const run = async () => {
    setError(null);
    setPhase("installing");
    try {
      const result = await installUpdate();
      setDoneMessage(result.message);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  // After an install the badge becomes the restart button.
  const restart = async () => {
    try {
      await restartApp();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const label =
    phase === "installing"
      ? "installing…"
      : phase === "done"
        ? "restart to finish"
        : phase === "error"
          ? "update failed — retry"
          : `${status.tag} available — install`;
  const title =
    phase === "error"
      ? `Update failed: ${error}`
      : phase === "done"
        ? `${doneMessage ?? "Installed."} Click to restart now.`
        : `Download and install ${status.tag} (currently ${status.current}).`;

  return (
    <button
      type="button"
      onClick={phase === "installing" ? undefined : phase === "done" ? restart : run}
      disabled={phase === "installing"}
      className={`tap-target flex items-center gap-1 rounded-sm px-1 font-medium hover:bg-accent ${
        phase === "error"
          ? "text-destructive"
          : phase === "done"
            ? "text-emerald-600 dark:text-emerald-500"
            : "text-amber-600 dark:text-amber-500"
      }`}
      title={title}
    >
      {phase === "installing" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : phase === "done" ? (
        <Check className="size-3" aria-hidden />
      ) : (
        <ArrowUpCircle className="size-3" aria-hidden />
      )}
      {label}
    </button>
  );
}

/**
 * Reroute target="_blank" anchors through the sidecar while running native.
 * Capture phase so it wins over React's own handlers; only plain left-clicks
 * on http(s) anchors are taken over, everything else keeps its behavior.
 */
function useExternalLinkBridge(native: boolean) {
  useEffect(() => {
    if (!native) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.(
        'a[target="_blank"]',
      ) as HTMLAnchorElement | null;
      if (!anchor?.href || !/^https?:/.test(anchor.href)) return;
      e.preventDefault();
      void openExternal(anchor.href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [native]);
}

export function StatusBar() {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const native = version?.native === true;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getVersion()
        .then((v) => {
          if (!cancelled) setVersion(v);
        })
        .catch(() => {
          // No identity, no bar content — never break the shell over it.
        });
    void load();
    // Read once on mount is right for a build that cannot change under the
    // page — except on a host updating itself, where it does exactly that.
    const onBuildChanged = () => void load();
    window.addEventListener("nexux:build-changed", onBuildChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("nexux:build-changed", onBuildChanged);
    };
  }, []);

  useExternalLinkBridge(native);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-[11px] text-muted-foreground">
      {/* Resources sit left, build identity right: the numbers are glanced at
          constantly and the version is looked up deliberately. */}
      <SystemMeters />
      <span className="ml-auto" />
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT))}
        className="flex items-center gap-1 hover:text-foreground"
        title="Open the assistant (⌘I)"
      >
        <Sparkles className="h-3 w-3" /> Assistant
      </button>
      <ZoomControl />
      <UpdateBadge native={native} />
      {version && (
        <span
          className="flex items-center gap-1"
          title={`Version ${version.version}${version.gitSha ? ` · commit ${version.gitSha}` : ""}${version.builtAt ? ` · built ${version.builtAt}` : ""}`}
        >
          <a
            href={version.releaseUrl}
            target="_blank"
            rel="noreferrer"
            className="tap-target rounded-sm px-1 font-medium hover:bg-accent hover:text-foreground"
            title={`Open release v${version.version} on GitHub`}
          >
            v{version.version}
          </a>
          {version.gitSha && version.commitUrl && (
            <a
              href={version.commitUrl}
              target="_blank"
              rel="noreferrer"
              className="tap-target rounded-sm px-1 font-mono hover:bg-accent hover:text-foreground"
              title={`Open commit ${version.gitSha} on GitHub`}
            >
              @{version.gitSha.slice(0, 7)}
            </a>
          )}
        </span>
      )}
    </footer>
  );
}
