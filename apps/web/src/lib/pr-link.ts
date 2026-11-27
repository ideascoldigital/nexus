// A pull / merge request URL, read for a small chip: "owner/repo #42" and
// which host it lives on. Pure.

export type PrLink = { url: string; host: "github" | "gitlab" | "other"; repo: string | null; number: string | null; label: string };

export function parsePrLink(raw: string): PrLink | null {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
  const path = url.pathname.replace(/\/+$/, "");
  const gh = path.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (gh) return { url: url.href, host: url.hostname === "github.com" ? "github" : "other", repo: gh[1]!, number: gh[2]!, label: `${gh[1]} #${gh[2]}` };
  const gl = path.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (gl) return { url: url.href, host: "gitlab", repo: gl[1]!, number: gl[2]!, label: `${gl[1]!.split("/").pop()} !${gl[2]}` };
  return { url: url.href, host: "other", repo: null, number: null, label: `${url.hostname}${path}`.slice(0, 60) };
}
