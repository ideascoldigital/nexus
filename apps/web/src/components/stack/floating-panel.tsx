"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, PanelRightClose, PanelRightOpen, X } from "lucide-react";

import {
  clampToViewport,
  initialFloatingSpot,
  isUnplaced,
  placementKey,
  readPlacement,
  type PanelPlacement,
} from "@/lib/panel-placement";

export type { PanelPlacement };

/** The live viewport, for the clamp. */
function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * A panel that floats where the user dragged it, or docks to the side.
 *
 * Floating is the default for a chat: a docked panel competes for width with
 * the canvas you are describing to it, which is the thing you are looking at
 * while you type. Docking stays available because once a conversation gets
 * long, a column that does not cover anything is easier to read.
 *
 * Renders its children either way — the panel inside does not know which mode
 * it is in, so a chat, an inspector or anything else can use this.
 */
export function FloatingPanel({
  id,
  title,
  icon,
  defaultPlacement = { mode: "floating", x: 0, y: 0 },
  onClose,
  children,
}: {
  /** Distinguishes this panel's remembered placement from another's. */
  id: string;
  title: string;
  icon?: React.ReactNode;
  defaultPlacement?: PanelPlacement;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Read storage in the initializer, not in an effect. With an effect, the
  // first committed state is still the unpositioned default, and the
  // first-paint effect below reacts to it — overwriting the placement that
  // was just loaded, and the stored value with it.
  const [placement, setPlacement] = useState<PanelPlacement>(() =>
    readPlacement(globalThis.localStorage, id, defaultPlacement),
  );
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Where inside the header the pointer grabbed, so the panel does not jump to
  // put its corner under the cursor.
  const grabOffset = useRef({ x: 0, y: 0 });

  // The initializer covers mount; this covers a panel that changes identity
  // while mounted. Skipping the first run matters: re-reading storage on mount
  // would undo a placement the user changed before this effect settled.
  const loadedId = useRef(id);
  useEffect(() => {
    if (loadedId.current === id) return;
    loadedId.current = id;
    setPlacement(readPlacement(globalThis.localStorage, id, defaultPlacement));
    // defaultPlacement is a literal at the call site; re-reading on every
    // render would fight the user's own choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const persist = useCallback(
    (next: PanelPlacement) => {
      setPlacement(next);
      try {
        window.localStorage.setItem(placementKey(id), JSON.stringify(next));
      } catch {
        // Private mode, blocked storage: the panel still works, it just
        // forgets. Not worth failing a drag over.
      }
    },
    [id],
  );

  // A floating panel that starts at 0,0 is in the corner under the header, so
  // an unpositioned one is placed near the bottom right on first paint.
  useEffect(() => {
    if (!isUnplaced(placement)) return;
    const el = panelRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    persist({
      mode: "floating",
      ...initialFloatingSpot(width, height, viewport()),
    });
  }, [placement, persist]);

  // Drag, via pointer events so a finger and a mouse take the same path.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: PointerEvent) => {
      const el = panelRef.current;
      if (!el) return;
      const { width, height } = el.getBoundingClientRect();
      persist({
        mode: "floating",
        ...clampToViewport(
          e.clientX - grabOffset.current.x,
          e.clientY - grabOffset.current.y,
          width,
          height,
          viewport(),
        ),
      });
    };
    const onUp = () => setDragging(false);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, persist]);

  // A window that got smaller can leave the panel off screen entirely, with no
  // way to drag it back — its handle is out there too.
  useEffect(() => {
    const onResize = () => {
      const el = panelRef.current;
      if (!el || placement.mode !== "floating") return;
      const { width, height } = el.getBoundingClientRect();
      const next = clampToViewport(
        placement.x,
        placement.y,
        width,
        height,
        viewport(),
      );
      if (next.x !== placement.x || next.y !== placement.y) {
        persist({ mode: "floating", ...next });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [placement, persist]);

  const startDrag = (e: React.PointerEvent) => {
    // Only the primary button, and never from a button inside the header.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    grabOffset.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    setDragging(true);
  };

  const floating = placement.mode === "floating";

  return (
    <div
      ref={panelRef}
      className={
        floating
          ? "fixed z-40 flex w-[min(26rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-popover shadow-2xl"
          : // Docked pins to the right edge rather than joining the resizable
            // split: the split's panels are declared up-front, and a panel that
            // appears and disappears would renumber them mid-drag.
            "fixed top-14 right-0 bottom-8 z-40 flex w-[min(26rem,100vw)] flex-col border-l border-border/60 bg-popover shadow-2xl"
      }
      style={
        floating
          ? {
              left: placement.x,
              top: placement.y,
              // Tall enough to hold a conversation, short enough to leave the
              // canvas visible behind it.
              height: "min(32rem, calc(100vh - 6rem))",
            }
          : undefined
      }
    >
      <div
        onPointerDown={floating ? startDrag : undefined}
        className={`flex items-center gap-2 border-b border-border/60 px-3 py-2.5 ${
          floating ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
        }`}
        // Without this a drag selects the title text instead of moving the
        // panel, which looks like the drag is broken.
        style={floating ? { userSelect: "none", touchAction: "none" } : undefined}
      >
        {floating ? (
          <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        {icon}
        <span className="truncate text-sm font-medium">{title}</span>

        <button
          type="button"
          onClick={() =>
            persist(floating ? { mode: "docked" } : { mode: "floating", x: 0, y: 0 })
          }
          aria-label={floating ? "Dock to the side" : "Float"}
          title={floating ? "Dock to the side" : "Float"}
          className="tap-target ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {floating ? (
            <PanelRightClose className="h-4 w-4" />
          ) : (
            <PanelRightOpen className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="tap-target rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
