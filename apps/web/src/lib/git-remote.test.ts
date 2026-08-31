import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { detectRepoUrl, normalizeGitUrl } from "./git-remote";

const execFileAsync = promisify(execFile);

/** An empty git repo, optionally with an `origin` remote already set. */
async function tmpGitRepo(origin?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nexux-git-remote-"));
  await execFileAsync("git", ["-C", dir, "init", "--quiet"]);
  if (origin) {
    await execFileAsync("git", ["-C", dir, "remote", "add", "origin", origin]);
  }
  return dir;
}

test("an scp-style remote becomes https", () => {
  assert.equal(
    normalizeGitUrl("git@github.com:owner/repo.git"),
    "https://github.com/owner/repo.git"
  );
});

test("an ssh:// remote becomes https", () => {
  assert.equal(
    normalizeGitUrl("ssh://git@github.com/owner/repo"),
    "https://github.com/owner/repo"
  );
});

test("an ssh:// remote without a user becomes https", () => {
  assert.equal(
    normalizeGitUrl("ssh://github.com/owner/repo.git"),
    "https://github.com/owner/repo.git"
  );
});

test("an https remote is passed through unchanged", () => {
  assert.equal(
    normalizeGitUrl("https://github.com/owner/repo.git"),
    "https://github.com/owner/repo.git"
  );
});

test("an http remote is left alone rather than upgraded", () => {
  assert.equal(
    normalizeGitUrl("http://git.internal/owner/repo.git"),
    "http://git.internal/owner/repo.git"
  );
});

test("surrounding whitespace is trimmed", () => {
  // detectRepoUrl feeds this raw `git remote get-url` stdout, newline included.
  assert.equal(
    normalizeGitUrl("git@github.com:owner/repo.git\n"),
    "https://github.com/owner/repo.git"
  );
});

test("a nested path survives normalization", () => {
  assert.equal(
    normalizeGitUrl("git@gitlab.com:group/subgroup/repo.git"),
    "https://gitlab.com/group/subgroup/repo.git"
  );
});

test("a self-hosted host is preserved", () => {
  assert.equal(
    normalizeGitUrl("git@git.internal.dev:team/repo.git"),
    "https://git.internal.dev/team/repo.git"
  );
});

test("an empty remote has no https equivalent", () => {
  assert.equal(normalizeGitUrl(""), null);
  assert.equal(normalizeGitUrl("   \n"), null);
});

test("a local path remote has no https equivalent", () => {
  // A clone from disk cannot be reached from a sandbox.
  assert.equal(normalizeGitUrl("/srv/repos/app.git"), null);
  assert.equal(normalizeGitUrl("../sibling-repo"), null);
});

test("a git:// remote has no https equivalent", () => {
  assert.equal(normalizeGitUrl("git://github.com/owner/repo.git"), null);
});

test("reads and normalizes a checkout's origin", async () => {
  const dir = await tmpGitRepo("git@github.com:owner/repo.git");
  assert.equal(await detectRepoUrl(dir), "https://github.com/owner/repo.git");
});

test("a repo with no origin yields no clone url", async () => {
  const dir = await tmpGitRepo();
  assert.equal(await detectRepoUrl(dir), null);
});

test("a directory that is not a git repo yields no clone url", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nexux-git-remote-plain-"));
  assert.equal(await detectRepoUrl(dir), null);
});

test("a path that does not exist yields no clone url", async () => {
  assert.equal(
    await detectRepoUrl(path.join(tmpdir(), "nexux-git-remote-missing")),
    null
  );
});

test("an origin with no https equivalent yields no clone url", async () => {
  const dir = await tmpGitRepo("git://github.com/owner/repo.git");
  assert.equal(await detectRepoUrl(dir), null);
});
