"use client";

// Thin wrappers over react-resizable-panels v4 so every split view looks and
// behaves the same: a hairline handle that lights up on hover/drag, a generous
// invisible hit area, and (via `persistId`) a layout that survives reloads.

import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type LayoutStorage,
} from "react-resizable-panels";
import type { ComponentProps } from "react";

export { usePanelRef } from "react-resizable-panels";

import { cn } from "@/lib/utils";

/**
 * `useDefaultLayout` defaults its `storage` to `localStorage`, and a default
 * parameter is evaluated on every call — including on the server, where the
 * global does not exist. Reading it there throws, which failed `next build` at
 * prerender *and* 500'd every SSR render of a page that persists a layout.
 * Keeping the lookup lazy is what makes those pages render at all.
 *
 * Restoring is a separate matter, and this cannot fix it alone. The hook feeds
 * `getItem` to `useSyncExternalStore` as both the client and the server
 * snapshot, and React keeps the server's answer through hydration — so on a
 * full page load the group mounts with "nothing saved" and shows the default
 * split, even though the layout is still in `localStorage`. Client-side
 * navigation, which never takes a server snapshot, restores it correctly.
 * Closing that last gap needs the group to render the saved layout on the
 * server too; `panelIds` is the library's hook for that, but it is folded into
 * the storage key (`react-resizable-panels:<id>:<...panelIds>`), so adding it
 * naively orphans every layout users have already saved under the bare id.
 */
const layoutStorage: LayoutStorage = {
  getItem: (name) =>
    typeof localStorage === "undefined" ? null : localStorage.getItem(name),
  setItem: (name, value) => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(name, value);
  },
};

/**
 * Group whose layout is persisted in localStorage under `persistId`.
 * Without `persistId` it behaves like a plain Group.
 */
export function ResizableGroup({
  className,
  orientation = "horizontal",
  persistId,
  plain,
  ...props
}: ComponentProps<typeof Group> & {
  persistId?: string;
  /** Render a plain flex container — see `ResizablePanel`'s `plain`. */
  plain?: boolean;
}) {
  // Hook order is stable: `persistId` is a constant per call site.
  const persisted = useDefaultLayout({
    id: persistId ?? "unpersisted",
    storage: layoutStorage,
  });
  const persistProps = persistId
    ? {
        defaultLayout: persisted.defaultLayout,
        onLayoutChanged: persisted.onLayoutChanged,
      }
    : {};

  if (plain) {
    const { defaultLayout, onLayoutChanged, ...rest } =
      props as Record<string, unknown>;
    void defaultLayout;
    void onLayoutChanged;
    return <div className={cn("flex w-full flex-col", className)} {...rest} />;
  }

  return (
    <Group
      orientation={orientation}
      className={cn(
        "flex w-full",
        orientation === "horizontal" ? "h-full flex-row" : "flex-col",
        className,
      )}
      {...persistProps}
      {...props}
    />
  );
}

export function ResizablePanel({
  className,
  plain,
  ...props
}: ComponentProps<typeof Panel> & {
  /**
   * Render a plain div instead of a resizable panel.
   *
   * For the narrow layout, where a split makes no sense. It has to be a
   * different *element*, not different classes: the library writes pixel sizes
   * inline, so `lg:flex-col` leaves a rail 108px wide with its content
   * shredded — and a vertical group is worse, because it divides a fixed
   * height and collapses growing content to zero.
   */
  plain?: boolean;
}) {
  if (plain) {
    const { defaultSize, minSize, maxSize, id, ...rest } =
      props as Record<string, unknown>;
    void defaultSize;
    void minSize;
    void maxSize;
    void id;
    return <div className={cn("min-w-0", className)} {...rest} />;
  }
  return <Panel className={cn("min-h-0 min-w-0", className)} {...props} />;
}

/**
 * Drag handle. `direction` describes the axis it resizes along — "horizontal"
 * (the default) renders a vertical line between side-by-side panels.
 */
export function ResizableHandle({
  className,
  direction = "horizontal",
  ...props
}: ComponentProps<typeof Separator> & {
  direction?: "horizontal" | "vertical";
}) {
  const isVerticalLine = direction === "horizontal";
  return (
    <Separator
      className={cn(
        "group relative shrink-0 bg-border/60 transition-colors",
        "hover:bg-primary/60 active:bg-primary",
        isVerticalLine ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
        className,
      )}
      {...props}
    >
      {/* Invisible hit area — the visible line stays 1px but stays grabbable. */}
      <span
        aria-hidden
        className={cn(
          "absolute",
          isVerticalLine
            ? "inset-y-0 -left-1.5 -right-1.5"
            : "inset-x-0 -top-1.5 -bottom-1.5",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
          "rounded-full bg-border opacity-0 transition-opacity group-hover:opacity-100",
          isVerticalLine ? "h-8 w-1" : "h-1 w-8",
        )}
      />
    </Separator>
  );
}
