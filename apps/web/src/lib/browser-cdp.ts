// Driving the browser session over the Chrome DevTools Protocol (spec 23).
//
// VNC carries pixels and input; it has no concept of a URL, so the address bar
// cannot be served over it. CDP is the channel that can — and it is the same
// one that lets an agent navigate and screenshot the app as the user sees it.
//
// CDP is bound to 127.0.0.1 on the instance, so every call here goes through
// the sandbox over exec rather than over the network: an open DevTools port is
// remote code execution with extra steps, able to read any origin the browser
// can reach, file:// included. Keeping it loopback-only is what makes the
// session safe to run at all, and that is worth a round trip.

import { execRemote, shq } from "@nexux/sandbox";

import { sandboxTarget } from "@/lib/agent-core";

/**
 * Where a session may be pointed.
 *
 * The whole purpose of the session is the sandbox's own services, and a bar
 * that reached arbitrary origins would turn a browser holding this instance's
 * localhost into a general-purpose fetcher, pointable by anything that can
 * reach the route. Loopback only.
 */
export function isLocalTarget(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * The curl that opens a tab on the given URL.
 *
 * The URL is single-quoted with `shq` — the same escaping both bootstraps use
 * — rather than passed through an environment variable: execRemote has no env
 * option (RemoteExecOpts is host/user/key/container/cwd/onLog/timeout/signal),
 * so a variable would expand to nothing and the navigate would silently open
 * about:blank.
 */
export function renderNavigateScript(cdpPort: number, url: string): string {
  return `curl -fs -X PUT "http://127.0.0.1:${cdpPort}/json/new?url=$(printf '%s' ${shq(url)} | sed -e 's/%/%25/g' -e 's/&/%26/g' -e 's/#/%23/g' -e 's/ /%20/g')"`;
}

/**
 * Point the session at a URL. Returns false when the target is not local or
 * CDP refused — the caller surfaces that rather than leaving the address bar
 * looking like it worked.
 */
export async function navigateSession(
  sandbox: Parameters<typeof sandboxTarget>[0],
  cdpPort: number,
  url: string,
): Promise<boolean> {
  if (!isLocalTarget(url)) return false;
  const res = await execRemote(renderNavigateScript(cdpPort, url), {
    ...sandboxTarget(sandbox, "/opt/nexus"),
    timeoutMs: 20_000,
  }).catch(() => null);
  return Boolean(res && res.code === 0);
}
