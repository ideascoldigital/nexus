/**
 * A GitHub token for talking to the Nexus repo itself (update check, asset
 * download). The repo is private, so an anonymous call answers 404 as if it
 * did not exist. Prefer env (CI, Docker), else any saved GitHub credential —
 * the same ones the repo pickers use. Never throws: no token just means the
 * unauthenticated path, which is also the right one once the repo is public.
 */
export async function githubToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { resolveGitCredential } = await import("@/lib/sandbox-manager");
    const cred = await resolveGitCredential(null, { provider: "github" });
    return cred?.token ?? null;
  } catch {
    return null;
  }
}
