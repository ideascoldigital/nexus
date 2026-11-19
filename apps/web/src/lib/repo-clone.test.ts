/**
 * Cloning a project's repositories onto this machine.
 *
 * Clones from a real `git init --bare` in a temp directory rather than a stub:
 * the thing worth testing is that git actually produces a working copy and that
 * the row ends up agreeing with the disk, and a faked `execFile` would assert
 * neither. No network is touched — a `file://` remote exercises the same code
 * path as an HTTPS one, minus the auth header.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

// Above every other import: @nexux/db builds its client at module load.
import { testDbDir } from "../app/api/routes.test-setup";
import { getConfig } from "@nexux/config";
import { prisma } from "@nexux/db";

import { cloneProjectRepositories, cloneRepository } from "./repo-clone";
import { resolveGitCredential } from "./sandbox-manager";

const execFileAsync = promisify(execFile);

let scratch: string;
/** A bare repo with one commit, standing in for the remote. */
let origin: string;

const PROJECT_ID = "proj-clone-test";

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-clone-"));
  origin = path.join(scratch, "origin.git");

  const seed = path.join(scratch, "seed");
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, "README.md"), "# seed\n");
  const git = (args: string[], cwd: string) =>
    execFileAsync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
  await git(["init", "-q", "-b", "main"], seed);
  await git(["add", "."], seed);
  await git(["commit", "-qm", "seed"], seed);
  await execFileAsync("git", ["clone", "-q", "--bare", seed, origin]);

  await prisma.workspace.create({
    data: { id: "ws-clone-test", name: "Clone" },
  });
  await prisma.project.create({
    data: { id: PROJECT_ID, workspaceId: "ws-clone-test", name: "Clone test" },
  });
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.repository.deleteMany({});
});

let seq = 0;
/** A repository row pointing at a fresh, not-yet-created target directory. */
async function repoRow(over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.repository.create({
    data: {
      projectId: PROJECT_ID,
      name: `repo${seq}`,
      repoUrl: `file://${origin}`,
      localPath: path.join(scratch, `work${seq}`),
      cloneStatus: "pending",
      ...over,
    },
  });
}

const statusOf = async (id: string) =>
  (await prisma.repository.findUnique({ where: { id } }))?.cloneStatus;

test("a pending repo is checked out and marked ready", async () => {
  const repo = await repoRow();
  const out = await cloneRepository(repo.id);

  assert.equal(out.status, "ready");
  assert.equal(await statusOf(repo.id), "ready");
  // The point of the whole exercise: files on disk, not just a status.
  assert.ok(fs.existsSync(path.join(repo.localPath!, "README.md")));
});

test("an existing checkout is adopted rather than re-cloned", async () => {
  // Pressing the button twice is how a partial failure gets retried, and
  // wiping a working copy that may hold local commits would be the more
  // expensive mistake.
  const repo = await repoRow();
  await cloneRepository(repo.id);
  const marker = path.join(repo.localPath!, "local-work.txt");
  fs.writeFileSync(marker, "uncommitted");

  const out = await cloneRepository(repo.id);
  assert.equal(out.status, "ready");
  assert.match(out.message, /Already checked out/);
  assert.ok(fs.existsSync(marker), "local file survived");
});

test("a non-empty directory that is not a checkout is left alone", async () => {
  const repo = await repoRow();
  fs.mkdirSync(repo.localPath!, { recursive: true });
  fs.writeFileSync(path.join(repo.localPath!, "someone-elses.txt"), "keep me");

  const out = await cloneRepository(repo.id);
  assert.equal(out.status, "error");
  assert.match(out.message, /not a git checkout/);
  assert.equal(await statusOf(repo.id), "error");
  assert.ok(fs.existsSync(path.join(repo.localPath!, "someone-elses.txt")));
});

test("a repo with no URL reports that instead of failing obscurely", async () => {
  const repo = await repoRow({ repoUrl: null });
  const out = await cloneRepository(repo.id);
  assert.equal(out.status, "error");
  assert.match(out.message, /No repository URL/);
});

test("a repo with no local path reports that instead of guessing one", async () => {
  const repo = await repoRow({ localPath: null });
  const out = await cloneRepository(repo.id);
  assert.equal(out.status, "error");
  assert.match(out.message, /No local path/);
});

// The failure a Nexus host actually hit: an install whose rows carried another
// machine's layout tried to clone into a root-owned directory and surfaced a
// bare "EACCES: permission denied, mkdir '/opt/workspace'". The path is named
// and the workspace is offered, because the useful fact is not that mkdir
// failed — it is that this repo is pointed somewhere it can never be cloned.
test("an unwritable destination is reported with the workspace to use instead", async () => {
  const denied = path.join(scratch, "denied");
  fs.mkdirSync(denied, { recursive: true });
  fs.chmodSync(denied, 0o500);
  try {
    const repo = await repoRow({ localPath: path.join(denied, "web") });
    const out = await cloneRepository(repo.id);

    assert.equal(out.status, "error");
    assert.equal(await statusOf(repo.id), "error");
    assert.match(out.message, /Cannot write to/);
    assert.ok(
      out.message.includes(denied),
      `names the directory that blocked it: ${out.message}`,
    );
    assert.ok(
      out.message.includes(getConfig().workspaceRoot),
      `points at the workspace: ${out.message}`,
    );
  } finally {
    fs.chmodSync(denied, 0o700);
  }
});

test("a failing clone records the error and git's own words", async () => {
  const repo = await repoRow({ repoUrl: `file://${scratch}/does-not-exist.git` });
  const out = await cloneRepository(repo.id);

  assert.equal(out.status, "error");
  assert.equal(await statusOf(repo.id), "error");
  assert.ok(out.message.length > 0, "message is not empty");
});

test("a token in a remote URL never reaches the stored message", async () => {
  // Git echoes the remote back in most failures; a URL carrying a token would
  // put it on screen and into the database.
  const repo = await repoRow({
    repoUrl: `https://x-access-token:ghp_supersecrettoken@127.0.0.1:1/o/r.git`,
  });
  const out = await cloneRepository(repo.id);

  assert.equal(out.status, "error");
  assert.ok(!out.message.includes("ghp_supersecrettoken"), out.message);
});

/** Add a commit to the bare remote, so a sync has something to pull. */
async function commitToOrigin(message: string) {
  const work = path.join(scratch, `push-${message}`);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  await execFileAsync("git", ["clone", "-q", origin, work]);
  fs.writeFileSync(path.join(work, `${message}.txt`), message);
  await execFileAsync("git", ["add", "."], { cwd: work, env });
  await execFileAsync("git", ["commit", "-qm", message], { cwd: work, env });
  await execFileAsync("git", ["push", "-q", "origin", "main"], {
    cwd: work,
    env,
  });
}

test("syncing pulls commits that landed on the remote", async () => {
  const repo = await repoRow();
  await cloneRepository(repo.id);

  await commitToOrigin("second");
  const out = await cloneRepository(repo.id, { sync: true });

  assert.equal(out.status, "ready", out.message);
  assert.match(out.message, /Updated to [0-9a-f]{7}/);
  assert.ok(fs.existsSync(path.join(repo.localPath!, "second.txt")));
});

test("syncing an up-to-date checkout says so rather than claiming a change", async () => {
  const repo = await repoRow();
  await cloneRepository(repo.id);

  const out = await cloneRepository(repo.id, { sync: true });
  assert.equal(out.status, "ready");
  assert.match(out.message, /Already up to date/);
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@e",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@e",
};
const gitIn = (dir: string, args: string[]) => execFileAsync("git", ["-C", dir, ...args], { env: GIT_ENV });

/** Push a commit that edits `file` on origin's main. */
async function commitFileToOrigin(label: string, file: string, content: string) {
  const work = path.join(scratch, `push-${label}`);
  await execFileAsync("git", ["clone", "-q", origin, work]);
  fs.writeFileSync(path.join(work, file), content);
  await gitIn(work, ["add", "."]);
  await gitIn(work, ["commit", "-qm", label]);
  await gitIn(work, ["push", "-q", "origin", "main"]);
}

test("local edits the update does not touch are kept, and the update still lands", async () => {
  // Refusing on any dirty file was stricter than git itself: a fast-forward
  // that does not touch the edited files is safe, and git knows which is which.
  const repo = await repoRow();
  await cloneRepository(repo.id);
  fs.writeFileSync(path.join(repo.localPath!, "README.md"), "edited locally");
  await commitToOrigin("untouched-by-me");

  const out = await cloneRepository(repo.id, { sync: true });
  assert.equal(out.status, "ready", out.message);
  assert.match(out.message, /Updated to/);
  assert.ok(fs.existsSync(path.join(repo.localPath!, "untouched-by-me.txt")));
  assert.equal(fs.readFileSync(path.join(repo.localPath!, "README.md"), "utf8"), "edited locally");
});

test("local edits the update does touch stop it, and nothing is changed", async () => {
  // This runs unattended from a button. Pulling over uncommitted work is how a
  // sync loses someone's afternoon.
  const repo = await repoRow();
  await cloneRepository(repo.id);
  fs.writeFileSync(path.join(repo.localPath!, "README.md"), "edited locally");
  await commitFileToOrigin("conflicting", "README.md", "edited upstream");

  const out = await cloneRepository(repo.id, { sync: true });
  assert.equal(out.status, "error");
  assert.match(out.message, /files the update touches — commit or stash/);
  assert.equal(fs.readFileSync(path.join(repo.localPath!, "README.md"), "utf8"), "edited locally");
});

test("a branch with no upstream adopts origin's branch of the same name", async () => {
  const repo = await repoRow();
  await cloneRepository(repo.id);
  // The branch exists on origin, but this checkout was created without tracking.
  const remoteWork = path.join(scratch, "push-feature");
  await execFileAsync("git", ["clone", "-q", origin, remoteWork]);
  await gitIn(remoteWork, ["checkout", "-qb", "feature"]);
  fs.writeFileSync(path.join(remoteWork, "feature.txt"), "f");
  await gitIn(remoteWork, ["add", "."]);
  await gitIn(remoteWork, ["commit", "-qm", "feature"]);
  await gitIn(remoteWork, ["push", "-q", "origin", "feature"]);
  await gitIn(repo.localPath!, ["checkout", "-qb", "feature"]);

  const out = await cloneRepository(repo.id, { sync: true });
  assert.equal(out.status, "ready", out.message);
  assert.match(out.message, /Updated to .*now tracking origin\/feature/);
  assert.ok(fs.existsSync(path.join(repo.localPath!, "feature.txt")));
});

test("a local-only branch is not an error, and main is still brought up to date", async () => {
  const repo = await repoRow();
  await cloneRepository(repo.id);
  await gitIn(repo.localPath!, ["checkout", "-qb", "docs/my-spec"]);
  await commitToOrigin("main-moved");

  const out = await cloneRepository(repo.id, { sync: true });
  assert.equal(out.status, "ready", out.message);
  assert.match(out.message, /docs\/my-spec is only local — nothing to pull/);
  assert.match(out.message, /main updated to [0-9a-f]{7}/);
  // main moved; the working tree (still on the feature branch) did not.
  assert.ok(!fs.existsSync(path.join(repo.localPath!, "main-moved.txt")));
  const mainHead = (await gitIn(repo.localPath!, ["rev-parse", "main"])).stdout.trim();
  const originHead = (await gitIn(repo.localPath!, ["rev-parse", "origin/main"])).stdout.trim();
  assert.equal(mainHead, originHead);
});

test("diverged history is reported with its counts, and left alone", async () => {
  const repo = await repoRow();
  await cloneRepository(repo.id);
  fs.writeFileSync(path.join(repo.localPath!, "mine.txt"), "mine");
  await gitIn(repo.localPath!, ["add", "."]);
  await gitIn(repo.localPath!, ["commit", "-qm", "mine"]);
  const before = (await gitIn(repo.localPath!, ["rev-parse", "HEAD"])).stdout.trim();
  await commitToOrigin("theirs");

  const out = await cloneRepository(repo.id, { sync: true });
  assert.equal(out.status, "error");
  assert.match(out.message, /diverged .*1 local and 1 remote commit/);
  assert.equal((await gitIn(repo.localPath!, ["rev-parse", "HEAD"])).stdout.trim(), before);
});

test("without sync an existing checkout is confirmed, not pulled", async () => {
  // The clone button must stay a no-op on a repo that is already there: it is
  // pressed to retry a *failed* repo, and quietly moving HEAD on the others
  // would be a surprise.
  const repo = await repoRow();
  await cloneRepository(repo.id);
  await commitToOrigin("third");

  const out = await cloneRepository(repo.id);
  assert.match(out.message, /Already checked out/);
  assert.ok(!fs.existsSync(path.join(repo.localPath!, "third.txt")));
});

// The failure a host hit: the GitHub token was saved and correct, but a GitLab
// credential had been created first. The old code took the *oldest* git
// credential of any provider, found it was not github, and sent no auth at all
// — so a private clone went out anonymous and git died on a username prompt.
test("a github token is used even when another provider's credential is older", async () => {
  const gitlab = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-clone-test",
      name: "gitlab-first",
      provider: "gitlab",
      data: { token: "glpat-older" },
    },
  });
  const github = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-clone-test",
      name: "github-second",
      provider: "github",
      data: { token: "ghp_the_one_that_should_win" },
    },
  });
  try {
    const picked = await resolveGitCredential(null, { provider: "github" });
    assert.equal(picked?.id, github.id);
    assert.equal(picked?.token, "ghp_the_one_that_should_win");
  } finally {
    await prisma.cloudCredential.deleteMany({
      where: { id: { in: [gitlab.id, github.id] } },
    });
  }
});

// A secretless import writes credential *shells* — the row exists, the token
// does not. Returning the oldest row regardless meant one of those shadowed a
// real token saved afterwards.
test("a credential shell with no token never shadows a real one", async () => {
  const shell = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-clone-test",
      name: "imported-without-secrets",
      provider: "github",
      data: {},
    },
  });
  const real = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-clone-test",
      name: "re-entered",
      provider: "github",
      data: { token: "ghp_actually_set" },
    },
  });
  try {
    const picked = await resolveGitCredential(null, { provider: "github" });
    assert.equal(picked?.id, real.id);
  } finally {
    await prisma.cloudCredential.deleteMany({
      where: { id: { in: [shell.id, real.id] } },
    });
  }
});

test("a saved token is not attached to a remote that needs none", async () => {
  // Found in the browser against a real public repository: attaching a stale
  // GitHub token makes the server *judge* it, so a clone that would have
  // succeeded anonymously fails with "Authentication failed". A saved
  // credential must therefore never be the reason a clone stops working.
  //
  // This covers the half that runs offline — a remote outside the three git
  // hosts gets no header at all. The retry-without-credentials path it feeds
  // needs a server that rejects tokens, so it is verified against github.com
  // rather than here.
  const cred = await prisma.cloudCredential.create({
    data: {
      workspaceId: "ws-clone-test",
      name: "stale",
      provider: "github",
      data: { token: "ghp_not_a_real_token" },
    },
  });
  try {
    const repo = await repoRow();
    const out = await cloneRepository(repo.id);
    assert.equal(out.status, "ready", out.message);
    assert.ok(fs.existsSync(path.join(repo.localPath!, "README.md")));
  } finally {
    await prisma.cloudCredential.delete({ where: { id: cred.id } });
  }
});

test("cloning a project does every repo and reports each one", async () => {
  const ok = await repoRow();
  const bad = await repoRow({ repoUrl: null });

  const results = await cloneProjectRepositories(PROJECT_ID);
  assert.equal(results.length, 2);
  // Partial success is the normal outcome, so one failure must not stop the
  // rest — the whole reason the caller gets a list rather than a boolean.
  assert.equal(results.find((r) => r.repoId === ok.id)?.status, "ready");
  assert.equal(results.find((r) => r.repoId === bad.id)?.status, "error");
});
