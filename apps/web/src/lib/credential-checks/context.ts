/**
 * Checks that depend on where a credential is used (spec 28 phase 4): can
 * this git token reach *this project's* repositories, and pull *this* image.
 * A token being valid is half the answer; these are the other half.
 */

import { webHostOfRegistry } from "@/lib/git-credentials";
import { gitHostOf } from "@/lib/git-host";

import { probe } from "./http";
import type { CheckLine, Fetch } from "./types";

/** `owner/repo` (or a GitLab `group/sub/project`) from any git URL form. */
export function repoPath(url: string): string | null {
  const trimmed = url.trim();
  const scp = trimmed.match(/^[^@/]+@[^:/]+:(.+)$/);
  const raw = scp ? scp[1] : trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\//i, "");
  const path = raw.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  return path.includes("/") ? path : null;
}

type Repo = { name: string; repoUrl: string | null };

/**
 * One line per repository on this credential's host: push, read-only, or not
 * visible. Repos on other hosts are left out — another credential covers them.
 */
export async function checkRepoAccess(
  cred: { provider: string; token: string; registryHost?: string | null },
  repos: Repo[],
  deps: { fetch?: Fetch } = {},
): Promise<CheckLine[]> {
  const fetchFn = deps.fetch ?? fetch;
  const token = cred.token.trim();
  const host =
    cred.provider === "github"
      ? "github.com"
      : cred.provider === "gitlab"
        ? (webHostOfRegistry(cred.registryHost) ?? "gitlab.com")
        : cred.provider === "bitbucket"
          ? "bitbucket.org"
          : null;
  if (!host) return [];

  const mine = repos.filter((r) => r.repoUrl && gitHostOf(r.repoUrl) === host);
  if (mine.length === 0) {
    return [{ label: `repos on ${host}`, ok: null, detail: "this project has none — nothing to check" }];
  }

  const lines: CheckLine[] = [];
  for (const repo of mine) {
    const path = repoPath(repo.repoUrl!);
    const label = `push to ${repo.name}`;
    if (!path) {
      lines.push({ label, ok: null, detail: "cannot read owner/repo from its URL" });
      continue;
    }
    if (cred.provider === "github") {
      const res = await probe(fetchFn, `https://api.github.com/repos/${path}`, {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      });
      if (!res.reached) lines.push({ label, ok: null, detail: res.error });
      else if (res.status === 404) lines.push({ label, ok: false, detail: "not visible with this token — private without access, or the URL is wrong" });
      else if (res.status >= 400) lines.push({ label, ok: false, detail: `GitHub answered ${res.status}` });
      else {
        const perms = (res.body as { permissions?: { push?: boolean; pull?: boolean } }).permissions;
        lines.push(
          perms?.push
            ? { label, ok: true }
            : perms?.pull
              ? { label, ok: false, detail: "read-only — sandboxes can clone but not push or open PRs" }
              : { label, ok: null, detail: "GitHub did not say — a fine-grained token may still be allowed" },
        );
      }
    } else if (cred.provider === "gitlab") {
      const res = await probe(fetchFn, `https://${host}/api/v4/projects/${encodeURIComponent(path)}`, { "PRIVATE-TOKEN": token });
      if (!res.reached) lines.push({ label, ok: null, detail: res.error });
      else if (res.status === 404) lines.push({ label, ok: false, detail: "not visible with this token" });
      else if (res.status >= 400) lines.push({ label, ok: false, detail: `GitLab answered ${res.status}` });
      else {
        const p = (res.body as { permissions?: { project_access?: { access_level?: number } | null; group_access?: { access_level?: number } | null } }).permissions;
        const level = Math.max(p?.project_access?.access_level ?? 0, p?.group_access?.access_level ?? 0);
        // 30 = Developer: the first role that can push branches.
        lines.push(
          level >= 30
            ? { label, ok: true }
            : level > 0
              ? { label, ok: false, detail: "Reporter or Guest — can read, cannot push" }
              : { label, ok: null, detail: "GitLab did not name a role (public project?)" },
        );
      }
    } else {
      lines.push({ label, ok: null, detail: "Bitbucket repository permissions are not checked yet" });
    }
  }
  return lines;
}
