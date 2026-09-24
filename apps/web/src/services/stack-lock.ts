// Spec 25 piece 3 — collecting the facts a lock records.
//
// The decisions (what a lock means, what changed between two) are pure and live
// in lib/stack/lock.ts. This is the half that reads git, docker and the
// database, and every read here is best-effort: a lock with a null digest is
// worth strictly more than no lock, so nothing in this file throws on a tool
// that is missing or a path that is not a checkout.

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { prisma } from "@nexux/db";

import {
  LOCK_VERSION,
  sourceFor,
  type LockSource,
  type LockedRepo,
  type LockedService,
  type StackLockData,
} from "@/lib/stack/lock";
import { healthcheckFor } from "@nexux/harness";

const execFileP = promisify(execFile);

/** Short, because a hung git on a network mount must not hang a validation. */
const TOOL_TIMEOUT_MS = 5_000;

async function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, {
      cwd,
      timeout: TOOL_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The lockfiles a unit might ship, in the order detection prefers them. */
const LOCKFILES = [
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "Gemfile.lock",
  "composer.lock",
];

/**
 * The unit's lockfile and its hash.
 *
 * Hashed rather than stored: the question a lock answers is "did this change",
 * which a digest settles, and keeping a megabyte of yaml per validation to
 * answer it would not.
 */
async function lockfileOf(
  dir: string,
): Promise<{ lockfile: string | null; lockfileSha256: string | null }> {
  for (const name of LOCKFILES) {
    try {
      const raw = await fs.readFile(path.join(dir, name));
      return {
        lockfile: name,
        lockfileSha256: crypto.createHash("sha256").update(raw).digest("hex"),
      };
    } catch {
      // Not this one.
    }
  }
  return { lockfile: null, lockfileSha256: null };
}

/**
 * Commit and cleanliness for one checkout.
 *
 * `dirty` is the field that carries weight: with a bind mount it says the
 * evidence covers files that exist on exactly one machine. A path that is not
 * a git checkout reports a null commit and dirty false — absence of a repo is
 * not evidence of uncommitted work.
 */
export async function gitStateOf(
  localPath: string,
): Promise<{ commit: string | null; dirty: boolean }> {
  const commit = await run("git", ["rev-parse", "HEAD"], localPath);
  if (commit === null) return { commit: null, dirty: false };
  const status = await run("git", ["status", "--porcelain"], localPath);
  return { commit, dirty: Boolean(status && status.length > 0) };
}

/**
 * The digest an image currently resolves to, from the local daemon only.
 *
 * No registry call: resolving a tag over the network turns a validation into
 * something that fails when the network does, and the digest is a nice-to-have.
 * An image the host has never pulled reports null, which reads correctly as
 * "we do not know" rather than "it has no digest".
 */
export async function digestOf(image: string): Promise<string | null> {
  const out = await run("docker", [
    "image",
    "inspect",
    image,
    "--format",
    "{{index .RepoDigests 0}}",
  ]);
  if (!out) return null;
  // "postgres@sha256:1a2b…" → "sha256:1a2b…"
  const at = out.lastIndexOf("@");
  return at === -1 ? null : out.slice(at + 1);
}

/** Versions of the tools that actually decide whether a build reproduces. */
export async function toolingVersions(): Promise<Record<string, string>> {
  const [node, pnpm, npm, docker] = await Promise.all([
    run("node", ["--version"]),
    run("pnpm", ["--version"]),
    run("npm", ["--version"]),
    run("docker", ["version", "--format", "{{.Server.Version}}"]),
  ]);
  const tooling: Record<string, string> = {};
  // node prints "v22.11.0"; the leading v is noise in a diff.
  if (node) tooling.node = node.replace(/^v/, "");
  if (pnpm) tooling.pnpm = pnpm;
  if (npm) tooling.npm = npm;
  if (docker) tooling.docker = docker;
  return tooling;
}

/**
 * Everything a lock records, gathered from the host.
 *
 * Repos are per *node*, not per repository: a monorepo contributes one node per
 * runnable unit (piece 1), and two units in one git can ship different
 * lockfiles. Sharing a commit is expected; sharing a lockfile is not.
 */
export async function collectLock(
  projectId: string,
  opts: { provider: string; sandboxId?: string | null },
): Promise<StackLockData> {
  const [nodes, repositories] = await Promise.all([
    prisma.stackNode.findMany({
      where: { projectId },
      select: {
        name: true,
        kind: true,
        image: true,
        workdir: true,
        repositoryId: true,
      },
    }),
    prisma.repository.findMany({
      where: { projectId },
      select: { id: true, name: true, localPath: true, repoUrl: true },
    }),
  ]);

  const repoById = new Map(repositories.map((r) => [r.id, r]));

  const repoNodes = nodes.filter((n) => n.kind === "repo" && n.repositoryId);
  const repos: LockedRepo[] = await Promise.all(
    repoNodes.map(async (node) => {
      const repo = repoById.get(node.repositoryId!);
      const root = repo?.localPath ?? null;
      if (!root) {
        return {
          name: node.name,
          repositoryId: node.repositoryId!,
          commit: null,
          dirty: false,
          lockfile: null,
          lockfileSha256: null,
        };
      }
      // The commit is the checkout's; the lockfile is the unit's. A workdir
      // that escapes the repo is not something to hash — resolve and check.
      const unitDir = node.workdir ? path.resolve(root, node.workdir) : root;
      const inside =
        unitDir === root || unitDir.startsWith(root + path.sep);
      const [git, lock] = await Promise.all([
        gitStateOf(root),
        inside
          ? lockfileOf(unitDir)
          : Promise.resolve({ lockfile: null, lockfileSha256: null }),
      ]);
      return {
        name: node.name,
        repositoryId: node.repositoryId!,
        commit: git.commit,
        dirty: git.dirty,
        ...lock,
      };
    }),
  );

  const serviceNodes = nodes.filter((n) => n.kind === "service" && n.image);
  const services: LockedService[] = await Promise.all(
    serviceNodes.map(async (node) => ({
      name: node.name,
      image: node.image!,
      digest: await digestOf(node.image!),
      // Whether the harness gives this image a real readiness probe. A service
      // nothing can probe is one whose "up" means only that the container
      // started (spec 24 piece 2).
      healthcheck: healthcheckFor(node.image!) !== null,
    })),
  );

  // Only the repos actually in the stack decide the source. A repository
  // registered on the project but absent from the canvas is not mounted by
  // anything and should not weaken the claim.
  const lockedRepoIds = new Set(repos.map((r) => r.repositoryId));
  const relevant = repositories.filter((r) => lockedRepoIds.has(r.id));

  return {
    lockVersion: LOCK_VERSION,
    provider: opts.provider,
    source: sourceFor(relevant),
    sandboxId: opts.sandboxId ?? null,
    repos,
    services,
    tooling: await toolingVersions(),
  };
}

/** Persists a lock. Called only after a validation came back green. */
export async function recordLock(
  projectId: string,
  lock: StackLockData,
): Promise<{ id: string; createdAt: Date }> {
  const row = await prisma.stackLock.create({
    data: {
      projectId,
      lockVersion: lock.lockVersion,
      provider: lock.provider,
      source: lock.source,
      sandboxId: lock.sandboxId,
      repos: lock.repos as never,
      services: lock.services as never,
      tooling: lock.tooling as never,
    },
    select: { id: true, createdAt: true },
  });
  return row;
}

export type StoredLock = StackLockData & { id: string; createdAt: string };

function toLockData(row: {
  id: string;
  createdAt: Date;
  lockVersion: number;
  provider: string;
  source: string;
  sandboxId: string | null;
  repos: unknown;
  services: unknown;
  tooling: unknown;
}): StoredLock {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lockVersion: row.lockVersion,
    provider: row.provider,
    source: row.source as LockSource,
    sandboxId: row.sandboxId,
    repos: (row.repos ?? []) as LockedRepo[],
    services: (row.services ?? []) as LockedService[],
    tooling: (row.tooling ?? {}) as Record<string, string>,
  };
}

/** The most recent locks, newest first. */
export async function recentLocks(
  projectId: string,
  take = 10,
): Promise<StoredLock[]> {
  const rows = await prisma.stackLock.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toLockData);
}
