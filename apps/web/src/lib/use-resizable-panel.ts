"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Constrain a panel width to the usable range.
 *
 * `viewport <= 0` means the window hasn't been measured yet (SSR, or a frame
 * before layout). Clamping against that would collapse a stored width to the
 * minimum, so the upper bound only applies once a real viewport is known.
 */
export function clampPanelWidth(
  value: number,
  {
    minWidth,
    maxWidthGap,
    viewport,
  }: { minWidth: number; maxWidthGap: number; viewport: number },
): number {
  const lower = Math.max(value, minWidth);
  if (viewport <= 0) return lower;
  return Math.min(lower, Math.max(minWidth, viewport - maxWidthGap));
}

/**
 * Drag-to-resize width for a right-side sheet, persisted in localStorage.
 *
 * The width is stored in pixels rather than a viewport fraction: the drawer
 * holds forms whose comfortable width doesn't scale with the monitor, so a
 * user who widened it on a big screen wants that same width back — not a
 * proportion of whatever screen they are on next.
 */
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth = 360,
  /** Leave a strip of the page clickable so the drawer never covers everything. */
  maxWidthGap = 120,
}: {
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidthGap?: number;
}) {
  // Start from the default on both server and first client render, then adopt
  // the stored width in an effect — reading localStorage during render would
  // make the markup differ from the server's and trip hydration.
  const [width, setWidth] = useState(defaultWidth);
  const [resizing, setResizing] = useState(false);
  const clamp = useCallback(
    (value: number) =>
      clampPanelWidth(value, {
        minWidth,
        maxWidthGap,
        viewport: typeof window === "undefined" ? 0 : window.innerWidth,
      }),
    [minWidth, maxWidthGap],
  );

  // Adopting the stored width has to happen after mount, not in the initial
  // state: the server renders the default, so reading localStorage during the
  // first render would produce markup that doesn't match and break hydration.
  // That makes this a genuine external-store sync rather than derived state.
  useEffect(() => {
    const stored = Number(localStorage.getItem(storageKey));
    if (!Number.isFinite(stored) || stored <= 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWidth(clamp(stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // A window that shrinks below the stored width would push the drawer off
  // screen; re-clamp instead of leaving it unreachable.
  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  /** Attach to the drag handle's `onPointerDown`. */
  const onResizeStart = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      setResizing(true);
      const startX = event.clientX;
      // Measure the panel the handle lives in rather than closing over render
      // state: the laid-out element is the truth at pointer-down, and it keeps
      // this handler free of stale-closure and ref-during-render problems.
      const panel = (event.currentTarget as HTMLElement)
        .parentElement as HTMLElement | null;
      const measured = panel?.getBoundingClientRect().width ?? 0;
      const startWidth = measured > 0 ? measured : defaultWidth;

      // Tracked locally: React may not have committed the last setWidth by the
      // time the pointer is released, and persisting a stale width would undo
      // the final part of the drag.
      let latest = startWidth;

      // Listening on the window (not the handle) keeps the drag alive when the
      // pointer outruns the 4px handle, which it always does.
      const onMove = (e: PointerEvent) => {
        // The drawer is anchored right, so dragging left grows it.
        latest = clamp(startWidth + (startX - e.clientX));
        setWidth(latest);
      };
      const onUp = () => {
        setResizing(false);
        localStorage.setItem(storageKey, String(latest));
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [clamp, storageKey, defaultWidth],
  );

  /** Keyboard resizing for the handle — arrows nudge, Home resets. */
  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 64 : 16;
      const delta =
        event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
      if (delta === 0 && event.key !== "Home") return;
      event.preventDefault();
      setWidth((current) => {
        const clamped = clamp(event.key === "Home" ? defaultWidth : current + delta);
        localStorage.setItem(storageKey, String(clamped));
        return clamped;
      });
    },
    [clamp, defaultWidth, storageKey],
  );

  return { width, resizing, onResizeStart, onResizeKeyDown };
}
