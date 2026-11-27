// A project's pull requests (spec 39, the project chat's Pull requests view):
// GitHub PRs and GitLab merge requests across its repositories, read with the
// git tokens saved in the Vault. Server-side only — tokens never reach the page.

import { prisma } from "@nexux/db";

export type PullRequest = {
  repo: string;
  provider: "github" | "gitlab";
  number: number;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  author: string | null;
  authorAvatar: string | null;
  source: string;
  target: string;
  url: string;
  updatedAt: string;
};

export type RepoRemote = { provider: "github" | "gitlab"; host: string; path: string };

/** Where a repository lives, from its URL. Pure. */
export function parseRemote(repoUrl: string, gitlabHosts: string[] = []): RepoRemote | null {
  let host: string;
  let path: string;
  const ssh = /^git@([^:]+):(.+)$/.exec(repoUrl.trim());
  if (ssh) {
    host = ssh[1]!.toLowerCase();
    path = ssh[2]!;
  } else {
    try {
      const u = new URL(repoUrl);
      host = u.host.toLowerCase();
      path = u.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!path.includes("/")) return null;
  if (host === "github.com") return { provider: "github", host, path };
  if (host.includes("gitlab") || gitlabHosts.includes(host)) return { provider: "gitlab", host, path };
  // Any other host: a self-hosted GitLab is by far the likeliest (git.company.com),
  // so try it as one when there is a GitLab token to try with.
  if (host !== "bitbucket.org" && gitlabHosts.includes("*")) return { provider: "gitlab", host, path };
  return null;
}

type Cred = { id: string; provider: string; data: unknown };
const tokenOf = (c: Cred | undefined) => ((c?.data ?? {}) as { token?: string }).token ?? null;
const hostOf = (c: Cred) => (((c.data ?? {}) as { registryHost?: string | null }).registryHost ?? "").toLowerCase();

/** The token for a remote: the repo's own pick, else one saved for that host. Pure. */
export function tokenFor(remote: RepoRemote, creds: Cred[], pick: string | null): string | null {
  const own = pick ? creds.find((c) => c.id === pick && c.provider === remote.provider) : undefined;
  if (own) return tokenOf(own);
  const ofProvider = creds.filter((c) => c.provider === remote.provider);
  if (remote.provider === "gitlab") {
    const byHost = ofProvider.find((c) => hostOf(c) === remote.host || hostOf(c).startsWith(`${remote.host}:`));
    if (byHost) return tokenOf(byHost);
    if (remote.host === "gitlab.com") return tokenOf(ofProvider.find((c) => !hostOf(c)));
    // A self-hosted server with no host on any token: the one GitLab token, if there is just one.
    return ofProvider.length === 1 ? tokenOf(ofProvider[0]) : null;
  }
  return tokenOf(ofProvider[0]);
}

async function githubPulls(remote: RepoRemote, token: string | null, repo: string): Promise<PullRequest[]> {
  const res = await fetch(`https://api.github.com/repos/${remote.path}/pulls?state=all&sort=updated&direction=desc&per_page=15`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}${res.status === 404 ? " (no access with the saved token?)" : ""}`);
  const rows = (await res.json()) as {
    number: number;
    title: string;
    state: string;
    draft?: boolean;
    merged_at: string | null;
    user?: { login: string; avatar_url: string };
    head: { ref: string };
    base: { ref: string };
    html_url: string;
    updated_at: string;
  }[];
  return rows.map((p) => ({
    repo,
    provider: "github",
    number: p.number,
    title: p.title,
    state: p.merged_at ? "merged" : p.state === "open" ? (p.draft ? "draft" : "open") : "closed",
    author: p.user?.login ?? null,
    authorAvatar: p.user?.avatar_url ?? null,
    source: p.head.ref,
    target: p.base.ref,
    url: p.html_url,
    updatedAt: p.updated_at,
  }));
}

async function gitlabMerges(remote: RepoRemote, token: string | null, repo: string): Promise<PullRequest[]> {
  const res = await fetch(
    `https://${remote.host}/api/v4/projects/${encodeURIComponent(remote.path)}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=15`,
    { headers: token ? { "PRIVATE-TOKEN": token } : {}, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) throw new Error(`GitLab answered ${res.status}${res.status === 401 || res.status === 404 ? " (no access with the saved token?)" : ""}`);
  const rows = (await res.json()) as {
    iid: number;
    title: string;
    state: string;
    draft?: boolean;
    work_in_progress?: boolean;
    author?: { username: string; avatar_url: string | null };
    source_branch: string;
    target_branch: string;
    web_url: string;
    updated_at: string;
  }[];
  return rows.map((m) => ({
    repo,
    provider: "gitlab",
    number: m.iid,
    title: m.title,
    state: m.state === "merged" ? "merged" : m.state === "opened" ? (m.draft || m.work_in_progress ? "draft" : "open") : "closed",
    author: m.author?.username ?? null,
    authorAvatar: m.author?.avatar_url ?? null,
    source: m.source_branch,
    target: m.target_branch,
    url: m.web_url,
    updatedAt: m.updated_at,
  }));
}

/** Every repository's recent PRs / MRs, newest first, and what could not be read. */
export async function projectPullRequests(projectId: string): Promise<{
  items: PullRequest[];
  errors: { repo: string; error: string }[];
  skipped: string[];
}> {
  const [repos, creds] = await Promise.all([
    prisma.repository.findMany({ where: { projectId }, select: { name: true, repoUrl: true, gitCredentialId: true } }),
    prisma.cloudCredential.findMany({ where: { provider: { in: ["github", "gitlab"] } }, select: { id: true, provider: true, data: true } }),
  ]);
  const gitlab = creds.filter((c) => c.provider === "gitlab");
  // "*": a GitLab token exists, so an unknown host is worth trying as GitLab.
  const gitlabHosts = [...gitlab.map((c) => hostOf(c).split(":")[0]!).filter(Boolean), ...(gitlab.length ? ["*"] : [])];
  const items: PullRequest[] = [];
  const errors: { repo: string; error: string }[] = [];
  const skipped: string[] = [];
  await Promise.all(
    repos.map(async (r) => {
      const remote = r.repoUrl ? parseRemote(r.repoUrl, gitlabHosts) : null;
      if (!remote) {
        skipped.push(r.name);
        return;
      }
      const token = tokenFor(remote, creds, r.gitCredentialId);
      try {
        items.push(...(remote.provider === "github" ? await githubPulls(remote, token, r.name) : await gitlabMerges(remote, token, r.name)));
      } catch (err) {
        errors.push({ repo: r.name, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  // Two folders on the same remote (a redesign checkout) show its PRs once.
  const seen = new Set<string>();
  const unique = items.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
  unique.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { items: unique, errors, skipped };
}
