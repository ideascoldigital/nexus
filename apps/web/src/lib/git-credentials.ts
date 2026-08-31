// Client-side helpers for picking a git credential. Shared by every form
// that offers the choice (project wizard, repositories tab) so the pickers
// cannot drift apart.

/** Providers a git credential can belong to. Mirrors the server's list. */
export const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"];

/**
 * How a credential is labelled in the pickers.
 *
 * The name alone is ambiguous — "personal" says nothing about which host it
 * belongs to, and the pickers list every provider until the URL names one.
 */
export function credentialLabel(c: { name: string; provider: string }): string {
  return `${c.name} (${c.provider})`;
}

/**
 * The credential provider a remote belongs to. Mirrors the server's mapping in
 * `repo-clone.ts`; the picker must offer exactly what the clone can use.
 */
export function providerOfUrl(repoUrl: string | null): string | null {
  if (!repoUrl) return null;
  let host: string;
  try {
    host = new URL(repoUrl).host.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes("github.com")) return "github";
  if (host.includes("gitlab.com")) return "gitlab";
  if (host.includes("bitbucket.org")) return "bitbucket";
  return null;
}

/**
 * The web host of a self-hosted git install, inferred from the container
 * registry the credential overrides.
 *
 * That override is already the field naming the instance elsewhere —
 * `selfHostedGitLabHost` takes it as the tiebreaker when a project's repo URLs
 * do not name one — so reading it here keeps one fact in one box instead of
 * asking for the same server twice.
 *
 * Best-effort by construction: `registry.gitlab.com` and `gitlab.acme.dev:5050`
 * both reduce to the host that serves the UI, but `registry.acme.dev` could
 * front a GitLab at `gitlab.acme.dev` just as easily as at `acme.dev`. Callers
 * must therefore *show* the host they resolved rather than hide it behind link
 * text, so a wrong guess is visible before it is clicked.
 */
export function webHostOfRegistry(registryHost?: string | null): string | null {
  const host = registryHost?.trim().toLowerCase().replace(/:\d+$/, "");
  if (!host) return null;
  return host.replace(/^registry\./, "") || null;
}

/**
 * A provider's token-creation deep link, pointed at the user's own instance.
 *
 * `defaultRegistryHost` is what stops the common case from being mangled: a
 * GitHub credential that spells out `ghcr.io` is naming the *public* registry,
 * not a GitHub Enterprise Server, and `ghcr.io` does not reduce to github.com —
 * so restating a provider's own registry leaves the link alone.
 */
export function tokenCreateUrl(
  base: string,
  registryHost?: string | null,
  defaultRegistryHost?: string | null,
): { url: string; host: string; overridden: boolean } {
  const fallback = (() => {
    try {
      return { url: base, host: new URL(base).host, overridden: false };
    } catch {
      return { url: base, host: base, overridden: false };
    }
  })();

  const typed = registryHost?.trim().toLowerCase().replace(/:\d+$/, "");
  if (!typed || typed === defaultRegistryHost?.trim().toLowerCase()) {
    return fallback;
  }

  const host = webHostOfRegistry(typed);
  if (!host || host === fallback.host) return fallback;

  try {
    const url = new URL(base);
    url.host = host;
    // The setter ignores a host it cannot parse, which would silently hand back
    // the public link while the label claims the private one.
    if (url.host !== host) return fallback;
    return { url: url.toString(), host, overridden: true };
  } catch {
    return fallback;
  }
}
