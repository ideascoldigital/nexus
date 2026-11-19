/**
 * Checking out a project's repositories on *this* machine.
 *
 * Sandboxes clone from their cloud-init (`template.ts`), and until now that was
 * the only place a `git clone` ever ran — the dashboard only ever *recorded* a
 * `cloneStatus` derived from whether a local path had been typed in. That gap
 * shows the moment an install is moved: an imported project arrives with real
 * repo URLs, real paths and `cloneStatus: "pending"` (import deliberately
 * refuses to claim a checkout it did not make), and nothing could turn that
 * into working copies. On a fresh Nexus host every repo sat at "Pending"
 * forever, which is the bug this file fixes.
 *
 * The token comes from the saved git credential and is passed through
 * `-c http.extraHeader`, never interpolated into the URL: a URL with a token in
 * it is written verbatim into `.git/config` as the origin remote, so every
 * later `git push` from a terminal would carry a secret the user never put
 * there — and `ps` shows it while the clone runs.
 */

import { execFile } from "child_process";
import { constants as fsConstants } from "fs";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";

import { normalizeGitUrl } from "@/lib/git-remote";
import { resolveGitCredential } from "@/lib/sandbox-manager";

const execFileAsync = promisify(execFile);

/** Long enough for a big repository on a slow link, short enough to not hang. */
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export type CloneOutcome = {
  repoId: string;
  name: string;
  status: "ready" | "error";
  /** What happened, for the UI to show without the user opening a terminal. */
  message: string;
};

/** Whether a directory already holds a git checkout. */
export async function isCheckedOut(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch {
    // Missing is as good as empty — clone creates it.
    return true;
  }
}

/** The provider a remote belongs to, or null when it is not one we hold tokens for. */
function providerOf(repoUrl: string): string | null {
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
 * The credential this repository should authenticate with.
 *
 * The repo's own pick wins; otherwise the first saved credential for the
 * remote's provider. That fallback is correct until an install holds two
 * accounts on the same host — a personal GitHub token plus an org one is
 * ordinary — at which point only an explicit choice can be right, which is what
 * `gitCredentialId` records.
 */
async function credentialForRepo(
  repoUrl: string,
  gitCredentialId: string | null,
) {
  const provider = providerOf(repoUrl);
  if (!provider) return null;
  return resolveGitCredential(gitCredentialId, { provider });
}

/**
 * The auth header git should send, when the host has a saved token for it.
 *
 * Basic with the token as the password is what every one of these accepts, and
 * unlike a token in the URL it leaves nothing behind in `.git/config`.
 */
function authHeaderFrom(cred: { token: string } | null): string[] {
  if (!cred) return [];
  const basic = Buffer.from(`x-access-token:${cred.token}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/**
 * Strip anything that looks like a credential out of git's stderr before it is
 * stored on the row and rendered in the UI. Git echoes the remote back in most
 * failure messages, and a URL that carried a token would put it on screen.
 */
function safeGitError(err: unknown): string {
  const raw =
    (err as { stderr?: string })?.stderr ||
    (err instanceof Error ? err.message : String(err));
  return raw
    .replace(/\/\/[^@\s/]+@/g, "//")
    .replace(/(gh[pous]_|github_pat_|glpat-)[A-Za-z0-9_]+/g, "$1…")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-4)
    .join(" ")
    .slice(0, 500);
}

/**
 * Whether this process can actually create `dir`.
 *
 * Walks up to the nearest ancestor that exists and asks for write permission
 * there, because that is where `mkdir -p` would fail. Worth doing before the
 * clone rather than after: on a Nexus host the app runs as an unprivileged uid
 * inside a container, so any path outside the declared workspace volume is
 * root-owned, and the raw failure is a bare `EACCES: permission denied, mkdir
 * '/opt/workspace'` — which says nothing about *why* that path was never going
 * to work, or where the repo should have gone instead.
 */
async function firstUnwritableAncestor(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  // Climb to the deepest ancestor that exists; `dirname("/") === "/"` ends it.
  for (;;) {
    try {
      await fs.stat(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }

  try {
    await fs.access(current, fsConstants.W_OK | fsConstants.X_OK);
    return null;
  } catch {
    return current;
  }
}

/**
 * Bring an existing checkout up to date with its remote — as far as can be
 * done without ever risking someone's work.
 *
 * Never merges, never rebases, never stashes: this runs unattended from a
 * button, and each of those can leave a tree in a state its owner did not
 * choose. What it does instead, in order:
 *
 * 1. `fetch --prune` — always safe, it moves only remote-tracking refs.
 * 2. A branch with no upstream adopts `origin/<same name>` when there is one.
 *    A branch that exists only here is not an error: there is nothing to
 *    pull, and saying so beats git's "no tracking information".
 * 3. Fast-forward the current branch with `merge --ff-only`, letting *git*
 *    judge uncommitted work: it proceeds when the incoming commits do not
 *    touch the edited files, and refuses — touching nothing — when they do.
 *    Refusing up front on any dirty file was stricter than it needed to be.
 * 4. Fast-forward the default branch too when it is not the one checked out
 *    (`fetch origin main:main` moves the ref only, never the working tree), so
 *    "update" still means main is current while a feature branch is open.
 *
 * Diverged history is reported with its counts for a human to resolve.
 */
async function pullRepository(
  dir: string,
  auth: string[],
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const git = (args: string[]) =>
    execFileAsync("git", ["-C", dir, ...args], {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  const read = (args: string[]) => git(args).then((r) => r.stdout.trim(), () => "");

  try {
    await git([...auth, "fetch", "--prune", "origin"]);
  } catch (err) {
    return { ok: false, message: safeGitError(err) };
  }

  const notes: string[] = [];
  const branch = await read(["symbolic-ref", "--short", "-q", "HEAD"]);
  // origin/HEAD names the default branch; "origin/main" → "main".
  const defaultBranch = (await read(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "") || "main";

  // The default branch, when it is not the one checked out: ref-only, so a
  // feature branch's working tree is never touched.
  const bumpDefault = async () => {
    if (!branch || branch === defaultBranch) return;
    const hasLocal = await read(["rev-parse", "--verify", "-q", `refs/heads/${defaultBranch}`]);
    const hasRemote = await read(["rev-parse", "--verify", "-q", `refs/remotes/origin/${defaultBranch}`]);
    if (!hasLocal || !hasRemote || hasLocal === hasRemote) return;
    try {
      await git(["fetch", ".", `refs/remotes/origin/${defaultBranch}:refs/heads/${defaultBranch}`]);
      notes.push(`${defaultBranch} updated to ${hasRemote.slice(0, 7)}`);
    } catch {
      notes.push(`${defaultBranch} has local commits — left as is`);
    }
  };

  if (!branch) {
    await bumpDefault();
    return { ok: true, message: ["Detached HEAD — fetched, nothing to pull", ...notes].join("; ") };
  }

  let upstream = await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) {
    if (await read(["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`])) {
      await git(["branch", `--set-upstream-to=origin/${branch}`, branch]).catch(() => undefined);
      upstream = `origin/${branch}`;
      notes.push(`now tracking origin/${branch}`);
    } else {
      await bumpDefault();
      return {
        ok: true,
        message: [`${branch} is only local — nothing to pull (push it to share it)`, ...notes].join("; "),
      };
    }
  }

  const counts = (await read(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).split(/\s+/);
  const ahead = Number(counts[0] ?? 0);
  const behind = Number(counts[1] ?? 0);

  if (behind > 0 && ahead > 0) {
    await bumpDefault();
    return {
      ok: false,
      message: [
        `${branch} has diverged from ${upstream}: ${ahead} local and ${behind} remote commit${behind === 1 ? "" : "s"} — merge or rebase it yourself`,
        ...notes,
      ].join("; "),
    };
  }

  if (behind > 0) {
    const before = await read(["rev-parse", "HEAD"]);
    try {
      await git(["merge", "--ff-only", upstream]);
    } catch (err) {
      const msg = safeGitError(err);
      await bumpDefault();
      return {
        ok: false,
        message: /would be overwritten/i.test(msg)
          ? [`Local changes in files the update touches — commit or stash them, then sync again`, ...notes].join("; ")
          : msg,
      };
    }
    const after = await read(["rev-parse", "HEAD"]);
    await bumpDefault();
    return { ok: true, message: [before === after ? "Already up to date" : `Updated to ${after.slice(0, 7)}`, ...notes].join("; ") };
  }

  await bumpDefault();
  return {
    ok: true,
    message: [
      ahead > 0 ? `Already up to date — ${ahead} local commit${ahead === 1 ? "" : "s"} not pushed` : "Already up to date",
      ...notes,
    ].join("; "),
  };
}

/**
 * Clone one repository into its recorded local path, or update the checkout
 * that is already there.
 *
 * Never re-clones over an existing checkout: the common reason to press the
 * button twice is that one repo of several failed, and wiping a working copy
 * that already has local commits to "fix" it would be the more expensive
 * mistake by far. A non-empty directory that is *not* a git checkout is left
 * alone and reported, for the same reason.
 */
export async function cloneRepository(
  repoId: string,
  /** Pull an existing checkout rather than just confirming it is there. */
  opts: { sync?: boolean } = {},
): Promise<CloneOutcome> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId } });
  if (!repo) throw new Error("Repository not found");

  const fail = async (message: string): Promise<CloneOutcome> => {
    await prisma.repository.update({
      where: { id: repoId },
      data: { cloneStatus: "error" },
    });
    return { repoId, name: repo.name, status: "error", message };
  };

  if (!repo.localPath) {
    return fail("No local path set — choose where this repo should live first.");
  }
  const target = repo.localPath;

  if (await isCheckedOut(target)) {
    if (!opts.sync) {
      // Record what is true rather than touching a working copy nobody asked
      // to change.
      await prisma.repository.update({
        where: { id: repoId },
        data: { cloneStatus: "ready" },
      });
      return {
        repoId,
        name: repo.name,
        status: "ready",
        message: "Already checked out — marked ready.",
      };
    }

    const url = repo.repoUrl ? normalizeGitUrl(repo.repoUrl) : null;
    const pulled = await pullRepository(
      target,
      authHeaderFrom(
        url ? await credentialForRepo(url, repo.gitCredentialId) : null,
      ),
    );
    if (!pulled.ok) return fail(pulled.message);
    await prisma.repository.update({
      where: { id: repoId },
      data: { cloneStatus: "ready" },
    });
    return {
      repoId,
      name: repo.name,
      status: "ready",
      message: pulled.message,
    };
  }

  if (!(await isEmptyDir(target))) {
    return fail(
      `${target} already exists and is not a git checkout. Move it aside, or point this repo somewhere else.`,
    );
  }

  if (!repo.repoUrl) return fail("No repository URL to clone from.");

  // Say *where* the checkout should live instead of echoing git's mkdir error.
  // The usual cause is an install whose paths were imported from another
  // machine: the rows carry that machine's layout, which on this one is a
  // directory only root can write.
  const blocked = await firstUnwritableAncestor(target);
  if (blocked) {
    const root = getConfig().workspaceRoot;
    return fail(
      `Cannot write to ${blocked} — this install has no permission to create ${target}. ` +
        `Point this repo somewhere under ${root} instead.`,
    );
  }

  // A remote already on this filesystem is handed to git untouched: it needs no
  // credentials and has no HTTPS form to normalize to. Everything else goes
  // through the same normalization sandbox clones use, because that is what
  // makes the saved token's auth header apply.
  const onDisk =
    repo.repoUrl.startsWith("/") || repo.repoUrl.startsWith("file:");
  const url = onDisk ? repo.repoUrl : normalizeGitUrl(repo.repoUrl);
  if (!url) {
    return fail(`"${repo.repoUrl}" is not a URL git can clone over HTTPS.`);
  }

  await prisma.repository.update({
    where: { id: repoId },
    data: { cloneStatus: "cloning" },
  });

  const run = (auth: string[]) =>
    execFileAsync("git", [...auth, "clone", url, target], {
      timeout: CLONE_TIMEOUT_MS,
      // Never let git stop for a username/password: with no token this must
      // fail with "authentication failed", not hang holding the request open.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

  const cred = await credentialForRepo(url, repo.gitCredentialId);

  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const auth = authHeaderFrom(cred);
    try {
      await run(auth);
    } catch (err) {
      // A saved token that the host rejects turns a *public* clone into
      // "Authentication failed" — sending credentials makes the server judge
      // them instead of ignoring them. Retry as nobody before reporting, so a
      // stale token cannot block a repository that needs no token at all.
      const authFailed = /authentication failed|invalid username or token/i.test(
        (err as { stderr?: string })?.stderr ?? "",
      );
      if (auth.length === 0 || !authFailed) throw err;
      await fs.rm(target, { recursive: true, force: true });
      await run([]);
    }
  } catch (err) {
    // `could not read Username` means git found no credentials and prompting
    // was disabled — it reads like a git fault, but it is ours: either no token
    // for this host is saved, or the one that is has no secret (a secretless
    // import leaves credential shells behind). Say which, and where to fix it,
    // because git's own words send people to look at the wrong thing.
    const needsToken = /could not read (Username|Password)|terminal prompts disabled/i.test(
      (err as { stderr?: string })?.stderr ?? "",
    );
    const provider = providerOf(url);
    if (needsToken && provider) {
      if (!cred) {
        return fail(
          `This repository is private and no ${provider} token is saved on this install. Add one under Settings → Git, then clone again.`,
        );
      }
      // Whether the token was *chosen* changes the fix entirely: a picked token
      // that fails is the wrong scope or expired, while an auto-picked one is
      // usually the right token for a different account — several ${provider}
      // credentials is ordinary, and nothing had told this repo which to use.
      return fail(
        repo.gitCredentialId
          ? `${provider} rejected “${cred.name}” for this private repository — check it has repo read access and has not expired (Settings → Git).`
          : `${provider} rejected “${cred.name}”, picked automatically because this repository has no credential set. If the repo belongs to another account, choose the right token for it on this repository.`,
      );
    }
    return fail(safeGitError(err));
  }

  await prisma.repository.update({
    where: { id: repoId },
    data: { cloneStatus: "ready" },
  });
  return {
    repoId,
    name: repo.name,
    status: "ready",
    message: `Cloned into ${target}`,
  };
}

/**
 * Clone every repository of a project that is not already checked out.
 *
 * Sequential on purpose: these are network- and disk-bound, several of them
 * belong to the same host, and a parallel burst is how a rate limit turns one
 * bad clone into all of them failing.
 */
export async function cloneProjectRepositories(
  projectId: string,
  opts: { sync?: boolean } = {},
): Promise<CloneOutcome[]> {
  const repos = await prisma.repository.findMany({
    where: { projectId },
    orderBy: [{ isMain: "desc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  const results: CloneOutcome[] = [];
  for (const { id } of repos) {
    results.push(await cloneRepository(id, opts));
  }
  return results;
}
