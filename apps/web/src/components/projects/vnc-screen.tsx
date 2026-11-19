"use client";

// The noVNC canvas, on its own so the sandbox panel and the full-tab view are
// the same screen rather than two that drift apart.

import { useEffect, useRef, useState } from "react";

/**
 * Connects once per session URL and tears the connection down on unmount — a
 * leaked RFB keeps a WebSocket open against a forward the server may already
 * have dropped.
 *
 * `className` sets the canvas box. The panel gives it a fixed height; the
 * full-tab view gives it the viewport, which is the whole reason this takes a
 * prop instead of hard-coding one.
 */
export function VncScreen({
  url,
  password,
  className = "h-[420px] w-full",
  rounded = true,
  fill = false,
}: {
  url: string;
  password: string;
  className?: string;
  /** The full-tab view fills the window, where a rounded border is a seam. */
  rounded?: boolean;
  /** Stretch to the parent's height instead of sizing to the canvas. */
  fill?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<{ disconnect: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // noVNC touches `document` when constructed, so it cannot be imported at
    // module scope in a server-rendered tree.
    void import("@novnc/novnc")
      .then(({ default: RFB }) => {
        if (cancelled || !containerRef.current) return;
        const wsUrl = url.replace(/^http/, "ws") + "/websockify";
        const rfb = new RFB(containerRef.current, wsUrl, {
          credentials: { password },
        });
        rfb.scaleViewport = true;
        // Not resizeSession: the sandbox's VNC server does not advertise the
        // resize extension, so asking the remote to adopt the container's
        // shape silently does nothing. The desktop stays at the geometry it
        // booted with (1440x900) and scaleViewport fits it in, which means a
        // window of a different aspect ratio gets letterboxed. Making the
        // browser fill a tall window is a change to how the sandbox starts its
        // X server, not to this canvas.
        rfb.background = "transparent";
        rfb.addEventListener("disconnect", () => {
          if (!cancelled) setError("The session disconnected.");
        });
        rfbRef.current = rfb;
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not connect");
        }
      });

    return () => {
      cancelled = true;
      try {
        rfbRef.current?.disconnect();
      } catch {
        // Already gone; nothing to release.
      }
      rfbRef.current = null;
    };
  }, [url, password]);

  return (
    <div
      className={`relative overflow-hidden bg-black ${
        rounded ? "rounded-md border" : ""
      } ${
        // Centred, so the space scaleViewport cannot use sits evenly around
        // the desktop instead of as one slab beneath it.
        fill ? "flex h-full min-h-0 flex-col items-center justify-center" : ""
      }`}
    >
      <div ref={containerRef} className={className} />
      {error && (
        <p className="absolute inset-x-0 bottom-0 bg-destructive/90 p-1 text-center text-[10px] text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
