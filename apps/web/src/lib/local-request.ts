/**
 * Guard for the native routes that act on the machine (install an update,
 * restart the app, open a URL with the OS opener).
 *
 * The sidecar has no authentication (D-34) and any page in any browser on this
 * machine can send requests to 127.0.0.1. Three checks, each closing a
 * different door:
 *
 *  1. Content-Type must be application/json by its MIME *essence*. A
 *     cross-origin JSON POST is not a "simple" request, so the browser
 *     preflights it and, since nothing here answers CORS, never sends it. A
 *     substring check would not do: `text/plain; x=application/json` is still
 *     text/plain to the browser — no preflight — yet contains the string.
 *  2. Sec-Fetch-Site, when the browser sends it, must be same-origin or none.
 *  3. The Host must be loopback. DNS rebinding points an attacker's hostname at
 *     127.0.0.1, which makes their page same-origin with this server; it cannot
 *     make the browser send `Host: 127.0.0.1`.
 *
 * Returns the reason to refuse, or null when the request may proceed.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostnameOf(host: string): string {
  // "[::1]:3030" → "[::1]", "127.0.0.1:3030" → "127.0.0.1"
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0];
}

export function localRequestRejection(req: Request): string | null {
  const essence = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (essence !== "application/json") return "expected a JSON request";

  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return "cross-site request refused";

  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOOPBACK.has(hostnameOf(host).toLowerCase())) return "request must come from this machine";

  return null;
}
