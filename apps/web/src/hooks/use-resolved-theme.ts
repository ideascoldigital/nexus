import { useSyncExternalStore } from "react";

/**
 * The theme actually on screen: the `dark` class on <html>, which the
 * appearance store sets (lib/appearance.ts) — "system" already resolved.
 *
 * For libraries with their own colour scheme (React Flow's `colorMode`) that
 * must match the page rather than be pinned. Watches the class, so a change
 * in Settings → Appearance, another tab, or the OS (under "system") lands
 * without a reload. The server renders dark, the app's default.
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function useResolvedTheme(): "dark" | "light" {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "dark",
  );
}
