/**
 * Per-viewer appearance: page width, zoom and theme.
 *
 * A matter of screen and taste rather than of the workspace, so each lives in
 * localStorage (like the sidebar's collapsed state):
 *
 * - width → `data-layout="full"` on <html>, which drives `--page-max-width`
 *   (globals.css).
 * - theme → the `dark` class on <html>; "system" follows the OS and keeps
 *   following it.
 * - zoom  → desktop app only: the webview's own zoom, through the shell's
 *   `set_zoom` command. Not CSS `zoom`: the layout is sized in viewport units
 *   (the shell is `h-svh`, dialogs are `max-h-[90vh]`), and those scale with
 *   CSS zoom — at 125% a 90vh dialog is 112% of the window. The webview's zoom
 *   is a browser's zoom, which handles all of that; in a browser, its own
 *   ⌘+ / ⌘− is the control. The View menu's shortcuts call
 *   `window.__nexuxZoom`, so the menu, Settings and the status bar step
 *   through one number.
 *
 * `APPEARANCE_BOOT_SCRIPT` applies width and theme inline in <head>, before
 * first paint, so a stored preference never flashes the defaults on load.
 * Zoom is restored by the bridge, once the page can reach the shell.
 */

export type LayoutWidth = "contained" | "full";
export type Theme = "dark" | "light" | "system";

export const LAYOUT_WIDTH_KEY = "nexux:layout-width";
export const ZOOM_KEY = "nexux:zoom";
export const THEME_KEY = "nexux:theme";

/** The steps ⌘+ / ⌘− walk through, as a browser's own zoom does. */
export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/** A stored zoom, or 1 when it is missing or nonsense. */
export function parseZoom(raw: string | null): number {
  const z = Number(raw);
  return Number.isFinite(z) && z >= ZOOM_STEPS[0] && z <= ZOOM_STEPS.at(-1)! ? z : 1;
}

/** The next step from `current` in `dir`; "reset" is 1. */
export function stepZoom(current: number, dir: "in" | "out" | "reset"): number {
  if (dir === "reset") return 1;
  if (dir === "in") return ZOOM_STEPS.find((s) => s > current + 1e-6) ?? ZOOM_STEPS.at(-1)!;
  return [...ZOOM_STEPS].reverse().find((s) => s < current - 1e-6) ?? ZOOM_STEPS[0];
}

export function resolveTheme(theme: Theme, prefersDark: boolean): "dark" | "light" {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

/**
 * Runs verbatim in <head>. Mirrors the apply functions below; kept as a string
 * because it is injected, and wrapped in try because storage can be
 * unavailable (private windows).
 */
export const APPEARANCE_BOOT_SCRIPT = `try{var d=document.documentElement,s=localStorage;
if(s.getItem(${JSON.stringify(LAYOUT_WIDTH_KEY)})==="full")d.dataset.layout="full";
var t=s.getItem(${JSON.stringify(THEME_KEY)});if(t==="light"||(t==="system"&&!matchMedia("(prefers-color-scheme: dark)").matches))d.classList.remove("dark");
}catch(e){}`;

// --- the desktop shell ---------------------------------------------------------

type TauriInternals = { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

/**
 * The desktop shell's IPC, when this page runs inside it. Tauri injects it
 * into every page of its webview; a capability scoped to the sidecar's origin
 * is what lets this page call `set_zoom`, and nothing else.
 */
function shell(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;
}

/** Whether zoom is ours to set — true inside the desktop app. */
export function canZoom(): boolean {
  return shell() !== null;
}

function applyZoom(level: number) {
  void shell()?.invoke("set_zoom", { level }).catch(() => undefined);
}

// --- stores -------------------------------------------------------------------

/** A localStorage value as a React external store, applied on set. */
function persisted<T>(key: string, read: (raw: string | null) => T, apply: (v: T) => void) {
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    subscribe(onChange: () => void) {
      listeners.add(onChange);
      // Another tab changed it: apply here too, then re-render.
      const onStorage = (e: StorageEvent) => {
        if (e.key !== key) return;
        apply(read(e.newValue));
        onChange();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    get(): T {
      try {
        return read(localStorage.getItem(key));
      } catch {
        return read(null);
      }
    },
    set(value: T) {
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Still apply it for this session.
      }
      apply(value);
      notify();
    },
  };
}

export const layoutWidthStore = persisted<LayoutWidth>(
  LAYOUT_WIDTH_KEY,
  (raw) => (raw === "full" ? "full" : "contained"),
  (width) => {
    if (width === "full") document.documentElement.dataset.layout = "full";
    else delete document.documentElement.dataset.layout;
  },
);

export const zoomStore = Object.assign(persisted<number>(ZOOM_KEY, parseZoom, applyZoom), {
  step(dir: "in" | "out" | "reset") {
    zoomStore.set(stepZoom(zoomStore.get(), dir));
  },
});

function applyTheme(theme: Theme) {
  const dark = resolveTheme(theme, matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark === "dark");
}

export const themeStore = persisted<Theme>(
  THEME_KEY,
  (raw) => (raw === "light" || raw === "system" ? raw : "dark"),
  applyTheme,
);

/**
 * Wiring that lives for the whole page: the desktop menu's zoom hook,
 * restoring the stored zoom (the webview starts every launch at 100%), and
 * following the OS when the theme is "system". Returns a cleanup.
 */
export function installAppearanceBridge(): () => void {
  const w = window as unknown as { __nexuxZoom?: (dir: "in" | "out" | "reset") => void };
  w.__nexuxZoom = (dir) => zoomStore.step(dir);
  const stored = zoomStore.get();
  if (stored !== 1) applyZoom(stored);

  // ⌘+ / ⌘− / ⌘0 inside the desktop app. The View menu already catches ⌘=
  // and ⌘−, and a key the menu takes never reaches the page — so this only
  // sees what the menu does not: ⌘+ as typed (⌘⇧=), the keypad keys, and
  // Ctrl on other platforms. In a browser, its own zoom owns these keys.
  const onKey = (e: KeyboardEvent) => {
    if (!canZoom() || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const dir =
      e.key === "+" || e.key === "=" ? "in" : e.key === "-" || e.key === "_" ? "out" : e.key === "0" ? "reset" : null;
    if (!dir) return;
    e.preventDefault();
    zoomStore.step(dir);
  };
  window.addEventListener("keydown", onKey);

  const media = matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    if (themeStore.get() === "system") applyTheme("system");
  };
  media.addEventListener("change", onScheme);
  return () => {
    delete w.__nexuxZoom;
    window.removeEventListener("keydown", onKey);
    media.removeEventListener("change", onScheme);
  };
}
