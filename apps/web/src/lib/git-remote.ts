import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Normalize a git remote URL to HTTPS so sandbox clones work: the bootstrap
 * authenticates via git `insteadOf` rules on https://<host>/ (no SSH keys on
 * the instance).
 *
 *   git@github.com:owner/repo.git      → https://github.com/owner/repo.git
 *   ssh://git@github.com/owner/repo    → https://github.com/owner/repo
 *   https://github.com/owner/repo.git  → unchanged
 */
export function normalizeGitUrl(remote: string): string | null {
  const url = remote.trim();
  if (!url) return null;
  if (url.startsWith("https://") || url.startsWith("http://")) return url;
  const ssh = url.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const scp = url.match(/^(?:[^@]+@)([^:]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  return null;
}

/**
 * Read the `origin` remote of a local checkout and normalize it to HTTPS.
 * Null when the path isn't a git repo, has no origin, or the URL has no
 * HTTPS equivalent — callers treat that as "no clone URL".
 */
export async function detectRepoUrl(localPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", localPath, "remote", "get-url", "origin"],
      { timeout: 5000 },
    );
    return normalizeGitUrl(stdout);
  } catch {
    return null;
  }
}
