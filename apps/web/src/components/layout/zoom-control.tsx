"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Minus, Plus } from "lucide-react";

import { canZoom, installAppearanceBridge, zoomStore } from "@/lib/appearance";

export function useZoom(): number {
  return useSyncExternalStore(zoomStore.subscribe, zoomStore.get, () => 1);
}

const noop = () => () => {};
/** True inside the desktop app — the only place zoom is ours to set. */
export function useCanZoom(): boolean {
  return useSyncExternalStore(noop, canZoom, () => false);
}

/**
 * − 100% + in the status bar, inside the desktop app. Clicking the percentage
 * resets it. Also where
 * the page-wide wiring lives (the desktop menu's zoom hook, theme following
 * the OS), because the status bar is on every page.
 */
export function ZoomControl() {
  const zoom = useZoom();
  const native = useCanZoom();
  useEffect(() => installAppearanceBridge(), []);

  // In a browser, its own ⌘+ / ⌘− is the zoom; a second one here would fight it.
  if (!native) return null;

  return (
    <span className="flex items-center font-mono" aria-label="Zoom">
      <button
        type="button"
        className="tap-target rounded-sm px-0.5 hover:bg-accent hover:text-foreground"
        onClick={() => zoomStore.step("out")}
        title="Zoom out (⌘−)"
        aria-label="Zoom out"
      >
        <Minus className="size-3" />
      </button>
      <button
        type="button"
        className="tap-target min-w-[2.75rem] rounded-sm px-1 text-center hover:bg-accent hover:text-foreground"
        onClick={() => zoomStore.step("reset")}
        title="Reset zoom (⌘0)"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className="tap-target rounded-sm px-0.5 hover:bg-accent hover:text-foreground"
        onClick={() => zoomStore.step("in")}
        title="Zoom in (⌘+)"
        aria-label="Zoom in"
      >
        <Plus className="size-3" />
      </button>
    </span>
  );
}
