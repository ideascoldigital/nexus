"use client";

// A panel's draggable edge. It lives *inside* the panel it resizes — an
// overflowing handle would be clipped by a scrolling body beside it — and the
// panel must establish a containing block (`relative`), or the handle lands on
// whichever ancestor is positioned.

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "@/lib/utils";

export function ResizeHandle({
  side,
  label,
  onResize,
  onReset,
  className,
}: {
  /** Which edge of the panel this sits on. */
  side: "left" | "right";
  label: string;
  /** The pointer's x, in CSS pixels from the left of the window. */
  onResize: (clientX: number) => void;
  /** Double-click: back to the default width. */
  onReset: () => void;
  className?: string;
}) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        dragging.current = true;
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => dragging.current && onResize(e.clientX)}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      className={cn(
        "group absolute inset-y-0 z-30 flex w-2.5 cursor-col-resize touch-none items-center justify-center",
        side === "left" ? "left-0" : "right-0",
        className,
      )}
    >
      <span
        className={cn(
          "h-10 w-1 rounded-full transition-colors",
          active ? "bg-foreground/60" : "bg-foreground/25 group-hover:bg-foreground/60",
        )}
      />
    </div>
  );
}
