// Where a movable panel sits, and the two rules that keep it usable: a stored
// placement must survive a reload, and a floating one must stay on screen.
//
// Separate from the component because both rules are decisions, not rendering,
// and the reload path in particular is one that manual clicking does not
// exercise — the placement looked correct right up until the page came back.

/** Where a floating panel sits, and whether it floats at all. */
export type PanelPlacement =
  | { mode: "docked" }
  | { mode: "floating"; x: number; y: number };

export const PLACEMENT_STORAGE_PREFIX = "nexux:panel-placement:";

export function placementKey(id: string): string {
  return PLACEMENT_STORAGE_PREFIX + id;
}

/** The minimal slice of Storage this needs, so a test can pass a fake. */
export type PlacementStore = Pick<Storage, "getItem" | "setItem">;

/**
 * Reads a stored placement, falling back when there is nothing usable.
 *
 * Placement is a preference about *their* screen, not about the project, so it
 * belongs in localStorage rather than the database: carrying it to another
 * machine with a different window size would restore coordinates that do not
 * fit there.
 *
 * Anything malformed falls back rather than throwing. A panel that refuses to
 * open because its remembered position is corrupt is worse than one that
 * forgets where it was.
 */
export function readPlacement(
  store: PlacementStore | undefined,
  id: string,
  fallback: PanelPlacement,
): PanelPlacement {
  if (!store) return fallback;
  try {
    const raw = store.getItem(placementKey(id));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as PanelPlacement;
    if (parsed?.mode === "docked") return { mode: "docked" };
    if (
      parsed?.mode === "floating" &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return { mode: "floating", x: parsed.x, y: parsed.y };
    }
  } catch {
    // Unreadable storage is a preference we do not have, not an error.
  }
  return fallback;
}

/** Whether a placement is one we should position by hand. */
export function isUnplaced(p: PanelPlacement): boolean {
  return p.mode === "floating" && p.x === 0 && p.y === 0;
}

/**
 * Keeps a floating panel on screen after a resize or on a smaller display.
 *
 * A margin rather than 0: a panel flush against the edge looks clipped, and
 * its drag handle becomes hard to grab. On a viewport narrower than the panel
 * the margin wins over centring — being able to reach the header matters more
 * than symmetry.
 */
export function clampToViewport(
  x: number,
  y: number,
  w: number,
  h: number,
  viewport: { width: number; height: number },
  margin = 8,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - w - margin);
  const maxY = Math.max(margin, viewport.height - h - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

/** Where an unplaced panel goes on first paint: bottom right, clear of chrome. */
export function initialFloatingSpot(
  w: number,
  h: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return clampToViewport(
    viewport.width - w - 24,
    viewport.height - h - 72,
    w,
    h,
    viewport,
  );
}
