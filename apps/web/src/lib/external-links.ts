/**
 * Links out of the desktop app.
 *
 * In a browser `target="_blank"` opens a tab and a cross-origin link
 * navigates — both are the browser's job and nothing here runs. Inside the
 * desktop shell there is no tab to open: the webview answers a new-window
 * request with nothing at all, so every outward link in the app was dead on
 * click (a release note in the status bar, a sandbox preview, and the links a
 * bot writes in its replies, which is where this was noticed). The webview's
 * own "open in new tab" is gone too — `NativeMenuGuard` takes the context
 * menu away — so there was no way out of the app by hand either.
 *
 * So inside the shell the page catches those clicks and hands the URL to the
 * opener plugin, which opens it in the real browser. The capability that
 * allows it (`external-links.json`) carries the plugin's default scope:
 * mailto, tel, http and https, and nothing else. Keeping the decision here
 * rather than at each link means a link written at runtime — by a bot, in
 * Markdown — is covered by the same rule as one in the source.
 */

type ShellInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function shell(): ShellInvoke | null {
  if (typeof window === "undefined") return null;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: ShellInvoke } })
    .__TAURI_INTERNALS__;
  return internals?.invoke ?? null;
}

/** Schemes the webview cannot act on itself; the OS has an app for each. */
const HANDED_OVER = new Set(["mailto:", "tel:"]);

export type LinkIntent = {
  href: string | null | undefined;
  target?: string | null;
};

/**
 * The URL this click should open outside the app, or null to leave the click
 * alone.
 *
 * Out: anything the author sent to a new window, anything on another origin,
 * and mailto/tel. Stays in: this app's own pages, and schemes the opener will
 * not take (blob:, data:, javascript:) — those are the page's business.
 */
export function externalUrl(link: LinkIntent, pageUrl: string): string | null {
  if (!link.href) return null;
  let url: URL;
  try {
    url = new URL(link.href, pageUrl);
  } catch {
    return null;
  }
  if (HANDED_OVER.has(url.protocol)) return url.href;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (link.target === "_blank") return url.href;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return null;
  }
  return url.origin === page.origin ? null : url.href;
}

/**
 * Sends outward clicks to the system browser, for as long as the page lives.
 * A no-op in a browser, where the link already works.
 */
export function installExternalLinkBridge(): () => void {
  const invoke = shell();
  if (!invoke) return () => {};
  const onClick = (event: MouseEvent) => {
    // Someone's own handler already took this click (a router, a menu).
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as
      | HTMLAnchorElement
      | null;
    if (!anchor) return;
    // A download is the webview's to fetch and save, not the browser's.
    if (anchor.hasAttribute("download")) return;
    const url = externalUrl(
      { href: anchor.getAttribute("href"), target: anchor.getAttribute("target") },
      window.location.href,
    );
    if (!url) return;
    event.preventDefault();
    void invoke("plugin:opener|open_url", { url }).catch(() => undefined);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
