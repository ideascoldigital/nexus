/**
 * The page-width preference: "contained" (the designed 72rem column) or
 * "full" (the whole window). Per viewer, like the sidebar's collapsed state —
 * a matter of screen and taste, not of the workspace — so it lives in
 * localStorage and is applied as `data-layout` on <html>, which drives
 * `--page-max-width` in globals.css.
 */

export type LayoutWidth = "contained" | "full";

export const LAYOUT_WIDTH_KEY = "nexux:layout-width";

/**
 * Runs inline in <head>, before first paint, so a full-width preference is in
 * place before anything renders. A string because it is injected verbatim;
 * wrapped in try because storage can be unavailable (private windows).
 */
export const LAYOUT_WIDTH_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  LAYOUT_WIDTH_KEY,
)})==="full")document.documentElement.dataset.layout="full"}catch(e){}`;

const listeners = new Set<() => void>();

export const layoutWidthStore = {
  subscribe(onChange: () => void) {
    listeners.add(onChange);
    window.addEventListener("storage", onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("storage", onChange);
    };
  },
  get(): LayoutWidth {
    try {
      return localStorage.getItem(LAYOUT_WIDTH_KEY) === "full" ? "full" : "contained";
    } catch {
      return "contained";
    }
  },
  set(width: LayoutWidth) {
    try {
      localStorage.setItem(LAYOUT_WIDTH_KEY, width);
    } catch {
      // Still apply it for this session.
    }
    if (width === "full") document.documentElement.dataset.layout = "full";
    else delete document.documentElement.dataset.layout;
    listeners.forEach((l) => l());
  },
};
