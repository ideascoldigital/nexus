"use client";

// "Nexus v0.3.6 installed — Restart". Mounted in the root layout so it shows on
// every surface (the bots app has no statusbar). It only ever appears in the
// native app: /api/updates/auto answers 404 everywhere else, and it stays
// hidden until the background auto-updater has actually installed something.

import { useEffect, useState } from "react";

import { Loader2, RotateCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  getAutoUpdateState,
  restartApp,
  type AutoUpdateState,
} from "@/services/updates";

const POLL_MS = 5 * 60 * 1000;

export function UpdateReadyNotice() {
  const [state, setState] = useState<AutoUpdateState | null>(null);
  const [dismissedTag, setDismissedTag] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let id: ReturnType<typeof setInterval> | undefined;
    const load = () =>
      getAutoUpdateState().then((s) => {
        // null = not native (404) or unreachable — nothing to show.
        if (!cancelled && s) setState(s);
        return s;
      });
    void load().then((s) => {
      // Off native there is no auto-updater: one 404, then no polling.
      if (s && !cancelled) id = setInterval(() => void load(), POLL_MS);
    });
    // Coming back to the window is when a notice is most likely to be read.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (state?.phase !== "installed" || !state.tag || dismissedTag === state.tag) return null;

  const restart = async () => {
    setError(null);
    setRestarting(true);
    try {
      await restartApp();
      // The app quits in about a second; leave the spinner up until it does.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRestarting(false);
    }
  };

  return (
    <div
      role="status"
      className="fixed bottom-10 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className="font-medium">Nexus {state.tag} is installed</p>
          <p className="text-xs text-muted-foreground">
            {state.canRestart
              ? "Restart to start using it. If you don't, it applies the next time you open Nexus."
              : "Quit and reopen Nexus to start using it."}
          </p>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
        <button
          type="button"
          onClick={() => setDismissedTag(state.tag ?? null)}
          className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {state.canRestart && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDismissedTag(state.tag ?? null)}>
            Later
          </Button>
          <Button size="sm" onClick={restart} disabled={restarting}>
            {restarting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <RotateCw className="size-3.5" aria-hidden />
            )}
            Restart
          </Button>
        </div>
      )}
    </div>
  );
}
