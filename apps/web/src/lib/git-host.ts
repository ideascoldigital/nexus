/**
 * Working out which git host a project's code lives on.
 *
 * Its own module, free of Prisma, so it stays a pure function the tests can
 * import without standing up a database.
 */

/** Strip scheme, userinfo and path from a host-ish string. */
function normalizeHost(value?: string | null): string | null {
  const host = value
    ?.trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]*@/, "")
    .split("/")[0]
    .toLowerCase();
  return host || null;
}

/** Host of a git remote, for both `https://host/x` and `git@host:x` forms. */
export function gitHostOf(url?: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const scp = trimmed.match(/^[^@/]+@([^:/]+):/);
  if (scp) return scp[1].toLowerCase();
  return normalizeHost(trimmed);
}

/** Git-hosting providers a saved credential can belong to. */
export type GitProvider = "github" | "gitlab" | "bitbucket";

/**
 * Hosts whose provider is known from the name alone. Everything else is
 * assumed to be a self-hosted GitLab — the only self-hosted flavour the
 * bootstrap can configure (`GITLAB_HOST`).
 */
const KNOWN_HOSTS: Record<string, GitProvider> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

/** The provider serving a host, or null when only a hint can decide. */
export function providerOfHost(host?: string | null): GitProvider | null {
  const normalized = normalizeHost(host);
  return normalized ? (KNOWN_HOSTS[normalized] ?? null) : null;
}

/**
 * Which providers a project actually needs tokens for, derived from where its
 * repos live.
 *
 * A project is routinely split across hosts — a GitLab monorepo plus a couple
 * of GitHub chart repos — and injecting one token means the other host clones
 * anonymously and dies as `could not read Username`. Scoping by the repos the
 * project declares keeps every sandbox to the tokens it has a use for, instead
 * of handing all of them to every box.
 *
 * An unrecognised host counts as the self-hosted GitLab, which is what
 * `selfHostedGitLabHost` then names.
 */
export function gitProvidersForRepos(
  repoUrls: Array<string | null | undefined>,
): Set<GitProvider> {
  const providers = new Set<GitProvider>();
  for (const url of repoUrls) {
    const provider = gitProviderOfUrl(url);
    if (provider) providers.add(provider);
  }
  return providers;
}

/** The provider a clone URL needs a token for; null for no URL. */
export function gitProviderOfUrl(url?: string | null): GitProvider | null {
  const host = gitHostOf(url);
  return host ? (KNOWN_HOSTS[host] ?? "gitlab") : null;
}

/**
 * The self-hosted GitLab instance a project's repos live on, or null when they
 * are on gitlab.com (where the token already works without extra config).
 *
 * Derived from the repo URLs rather than configured: the user already said
 * where the code is by adding the repository, and a token attached to *this*
 * project is meant for *those* hosts. The credential's saved host is the
 * tiebreaker for a project whose repos are still empty shells.
 *
 * Returns null when repos disagree — `GITLAB_HOST` names one instance, and
 * silently picking one of two would authenticate against the wrong one, which
 * reads as a permissions problem rather than a configuration one.
 */
export function selfHostedGitLabHost(
  repoUrls: Array<string | null | undefined>,
  credentialHost?: string | null,
): string | null {
  const hosts = new Set<string>();
  for (const url of repoUrls) {
    const host = gitHostOf(url);
    // Every host with a known provider is excluded, not just gitlab.com: a
    // project that keeps its charts on github.com alongside a self-hosted
    // GitLab used to read as two competing instances and resolve to nothing,
    // leaving GITLAB_HOST unset for the one host that needed it.
    if (host && !KNOWN_HOSTS[host]) hosts.add(host);
  }
  if (hosts.size === 1) return [...hosts][0];
  if (hosts.size > 1) return null;

  const fallback = normalizeHost(credentialHost);
  return fallback && fallback !== "gitlab.com" ? fallback : null;
}
