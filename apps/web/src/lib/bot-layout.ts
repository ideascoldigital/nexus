// How the bots view is laid out: where each per-viewer preference is stored and
// how wide the anchored computer may get. Pure, so it is cheap to test.

/**
 * Keys in window.localStorage. Per viewer and never required: when storage is
 * blocked the view falls back to these defaults.
 */
export const BOTS_KEYS = {
  /** When each bot's latest message was last seen (unread dots, NEW line). */
  seen: "nexux:bots-seen",
  /** The bot's details panel on the right. */
  panel: "nexux:bots-panel",
  /** How wide that panel is, in CSS pixels. */
  panelWidth: "nexux:bots-panel-width",
  /** The inbox on the left, collapsed to a rail of faces. */
  inbox: "nexux:bots-inbox",
  /** How wide the inbox is when it is not collapsed, in CSS pixels. */
  inboxWidth: "nexux:bots-inbox-width",
  /** Where each bot keeps its computer anchored, if anywhere. */
  dock: "nexux:bots-dock",
  /** How wide that anchored computer is, in CSS pixels. */
  dockWidth: "nexux:bots-dock-width",
} as const;

export const PANEL_DEFAULT_WIDTH = 380;
const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 760;

/** The details panel, which also holds the screen when it is anchored there. */
export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(width, PANEL_MIN_WIDTH), PANEL_MAX_WIDTH));
}

export const INBOX_DEFAULT_WIDTH = 300;
const INBOX_MIN_WIDTH = 210;
const INBOX_MAX_WIDTH = 460;

/** The inbox stays wide enough for a name and a preview line, and narrow
 *  enough that it is still a list and not the view. */
export function clampInboxWidth(width: number): number {
  if (!Number.isFinite(width)) return INBOX_DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(width, INBOX_MIN_WIDTH), INBOX_MAX_WIDTH));
}

export const DOCK_DEFAULT_WIDTH = 520;
export const DOCK_MIN_WIDTH = 320;
/** The chat keeps at least this much room, so you can still read and type. */
export const CHAT_MIN_WIDTH = 560;
/** …and never less than this share of a wide window. */
const CHAT_MIN_SHARE = 0.4;

/** The widest the anchored computer may be in a window this wide. */
export function maxDockWidth(viewport: number): number {
  const room = Math.min(viewport - CHAT_MIN_WIDTH, viewport * (1 - CHAT_MIN_SHARE));
  return Math.max(DOCK_MIN_WIDTH, Math.round(room));
}

/** A stored or dragged width, brought back inside what the window allows. */
export function clampDockWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return Math.min(DOCK_DEFAULT_WIDTH, maxDockWidth(viewport));
  return Math.round(Math.min(Math.max(width, DOCK_MIN_WIDTH), maxDockWidth(viewport)));
}

/**
 * Where a bot's screen is kept: nowhere (it opens as a dialog when asked),
 * anchored full height to the right of the chat, or under the bot's details in
 * the panel. Watching a screen is a property of the bot — only some of them
 * work in a browser — so the choice is remembered per bot, and a bot you have
 * not decided about keeps the dialog. An older build stored one boolean for
 * every bot; that value is ignored, which is the default anyway.
 */
export type DockMode = "off" | "right" | "panel";

export function dockModeFor(stored: unknown, botId: string): DockMode {
  if (typeof stored !== "object" || stored === null) return "off";
  const mode = (stored as Record<string, unknown>)[botId];
  return mode === "right" || mode === "panel" ? mode : "off";
}

/** The same map with this bot's choice written in ("off" means absent). */
export function rememberDockMode(
  stored: unknown,
  botId: string,
  mode: DockMode,
): Record<string, DockMode> {
  const all: Record<string, DockMode> = {};
  if (typeof stored === "object" && stored !== null) {
    for (const [id, v] of Object.entries(stored as Record<string, unknown>)) {
      if ((v === "right" || v === "panel") && id !== botId) all[id] = v;
    }
  }
  if (mode !== "off") all[botId] = mode;
  return all;
}
