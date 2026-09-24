// Spec 25 piece 3 — what a green validation passed against, and what changed
// since the last one.
//
// "Reproducible" had no definition in this codebase, and the largest source of
// drift is structural: a local sandbox bind-mounts repo folders while a cloud
// sandbox clones by URL. A stack validated locally was validated against your
// working tree, uncommitted files and all — and nothing said so.
//
// A lock is the statement that closes that: this booted, against these commits,
// these images, this tooling, reached this way. It is deliberately **not** a
// pin. Nothing reads it back to force a digest, because pinning an image the
// user did not pin has real consequences (a postgres that never gets a security
// patch) and the choice is theirs. The lock describes; if pinning is wanted
// later, this is the data to generate it from.
//
// Everything here is pure. Collecting the facts is I/O and lives in
// services/stack-lock.ts; deciding what they mean is a decision and lives here,
// where it can be tested without a sandbox.

/** How the code reached the sandbox — the local/cloud gap in one field. */
export type LockSource = "mount" | "clone";

export type LockedRepo = {
  name: string;
  repositoryId: string;
  /** Full sha, or null when the path is not a git checkout. */
  commit: string | null;
  /**
   * Uncommitted changes were present. Only meaningful with source "mount":
   * a clone cannot be dirty, so the field is about what the evidence covers,
   * not about repo hygiene.
   */
  dirty: boolean;
  /** e.g. "pnpm-lock.yaml". Null when the unit ships none. */
  lockfile: string | null;
  lockfileSha256: string | null;
};

export type LockedService = {
  name: string;
  image: string;
  /** Resolved digest when the host could report one; null otherwise. */
  digest: string | null;
  healthcheck: boolean;
};

export type StackLockData = {
  lockVersion: number;
  provider: string;
  source: LockSource;
  sandboxId: string | null;
  repos: LockedRepo[];
  services: LockedService[];
  /** Whatever the host could report: node, pnpm, docker… */
  tooling: Record<string, string>;
};

export const LOCK_VERSION = 1;

/**
 * How the code reached the sandbox.
 *
 * Derived from the repos rather than the provider, because the provider does
 * not decide it: `local.ts` bind-mounts only repos with no clone URL, so a
 * local sandbox whose repos all have remotes clones exactly like a cloud one.
 * Mixed is reported as "mount" — if any repo was mounted, the run saw a working
 * tree, and that is the weaker claim of the two.
 */
export function sourceFor(repos: Array<{ repoUrl: string | null }>): LockSource {
  return repos.some((r) => !r.repoUrl) ? "mount" : "clone";
}

/**
 * What this lock can honestly claim.
 *
 * The sentence the UI shows, and the reason `source` exists at all. A mounted
 * validation against a dirty tree proves the least — it booted against files
 * that exist on exactly one machine — and saying that plainly is better than a
 * green badge that implies more.
 */
export function describeLock(lock: StackLockData): string {
  const dirty = lock.repos.filter((r) => r.dirty).length;
  const repos = `${lock.repos.length} repo${lock.repos.length === 1 ? "" : "s"}`;

  if (lock.source === "mount") {
    return dirty > 0
      ? `Booted locally against ${repos}, ${dirty} with uncommitted changes — a cloud sandbox clones and may differ.`
      : `Booted locally against ${repos}, all committed — a cloud sandbox clones and may still differ.`;
  }
  return `Booted on ${lock.provider} against ${repos}, cloned at the recorded commits.`;
}

/** One thing that changed between two locks. */
export type LockChange = {
  kind: "repo" | "service" | "tooling";
  name: string;
  /** What changed about it, in the words the reader needs. */
  field: string;
  before: string | null;
  after: string | null;
};

function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, 7) : null;
}

/**
 * What changed between the lock that was green and the one that is not.
 *
 * The answer to "it worked on Tuesday". Ordered by how often each thing is
 * actually the cause: a moved commit first, then a dependency lockfile, then an
 * image that resolved to something new underneath an unchanged tag — which is
 * the one nobody can see today and the reason digests are recorded at all.
 *
 * Appearing and disappearing count as changes. A service that is simply gone
 * explains a boot failure as well as one that changed image.
 */
export function diffLocks(
  before: StackLockData,
  after: StackLockData,
): LockChange[] {
  const changes: LockChange[] = [];

  const beforeRepos = new Map(before.repos.map((r) => [r.repositoryId, r]));
  const afterRepos = new Map(after.repos.map((r) => [r.repositoryId, r]));

  for (const [id, a] of afterRepos) {
    const b = beforeRepos.get(id);
    if (!b) {
      changes.push({
        kind: "repo",
        name: a.name,
        field: "added",
        before: null,
        after: shortSha(a.commit),
      });
      continue;
    }
    if (b.commit !== a.commit) {
      changes.push({
        kind: "repo",
        name: a.name,
        field: "commit",
        before: shortSha(b.commit),
        after: shortSha(a.commit),
      });
    }
    if (b.lockfileSha256 !== a.lockfileSha256) {
      changes.push({
        kind: "repo",
        name: a.name,
        field: a.lockfile ?? b.lockfile ?? "lockfile",
        before: shortSha(b.lockfileSha256),
        after: shortSha(a.lockfileSha256),
      });
    }
    // Worth reporting on its own: the commit can be identical while the tree
    // is not, which is exactly the case where "but nothing changed" is wrong.
    if (b.dirty !== a.dirty) {
      changes.push({
        kind: "repo",
        name: a.name,
        field: "uncommitted changes",
        before: b.dirty ? "yes" : "no",
        after: a.dirty ? "yes" : "no",
      });
    }
  }
  for (const [id, b] of beforeRepos) {
    if (afterRepos.has(id)) continue;
    changes.push({
      kind: "repo",
      name: b.name,
      field: "removed",
      before: shortSha(b.commit),
      after: null,
    });
  }

  const beforeServices = new Map(before.services.map((s) => [s.name, s]));
  const afterServices = new Map(after.services.map((s) => [s.name, s]));

  for (const [name, a] of afterServices) {
    const b = beforeServices.get(name);
    if (!b) {
      changes.push({
        kind: "service",
        name,
        field: "added",
        before: null,
        after: a.image,
      });
      continue;
    }
    if (b.image !== a.image) {
      changes.push({
        kind: "service",
        name,
        field: "image",
        before: b.image,
        after: a.image,
      });
    }
    // The invisible one. Same tag, different bits — undetectable without this.
    if (b.digest !== a.digest && b.image === a.image) {
      changes.push({
        kind: "service",
        name,
        field: `${a.image} digest`,
        before: shortSha(b.digest),
        after: shortSha(a.digest),
      });
    }
  }
  for (const [name, b] of beforeServices) {
    if (afterServices.has(name)) continue;
    changes.push({
      kind: "service",
      name,
      field: "removed",
      before: b.image,
      after: null,
    });
  }

  const toolNames = new Set([
    ...Object.keys(before.tooling),
    ...Object.keys(after.tooling),
  ]);
  for (const tool of [...toolNames].sort()) {
    const b = before.tooling[tool] ?? null;
    const a = after.tooling[tool] ?? null;
    if (b !== a) {
      changes.push({ kind: "tooling", name: tool, field: "version", before: b, after: a });
    }
  }

  return changes;
}

/** A diff in one line, for a status row. */
export function summarizeChanges(changes: LockChange[]): string {
  if (changes.length === 0) return "Nothing changed since the last green run.";
  const head = changes
    .slice(0, 3)
    .map((c) =>
      c.before === null
        ? `${c.name} ${c.field}`
        : c.after === null
          ? `${c.name} ${c.field}`
          : `${c.name} ${c.field} ${c.before ?? "—"} → ${c.after ?? "—"}`,
    )
    .join(", ");
  const rest = changes.length - 3;
  return rest > 0 ? `${head}, and ${rest} more` : head;
}
