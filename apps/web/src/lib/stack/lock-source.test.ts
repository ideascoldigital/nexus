import { strict as assert } from "node:assert";
import { test } from "node:test";

import { sourceFor } from "@/lib/stack/lock";

// sourceFor is the one decision in the lock pipeline that is pure, so it is
// tested here. The rest of services/stack-lock.ts is git, docker and database
// reads whose whole contract is "return null rather than throw"; exercising
// that needs the real tools, which the manual verification against a running
// host covers.

test("a repo with no clone URL is bind-mounted, so the run saw a working tree", () => {
  assert.equal(sourceFor([{ repoUrl: null }]), "mount");
});

test("repos that all have remotes are cloned, even on a local provider", () => {
  // The reason source is derived from the repos and not the provider:
  // local.ts mounts only repos without a repoUrl, so a local sandbox whose
  // repos all have remotes clones exactly like a cloud one.
  assert.equal(
    sourceFor([{ repoUrl: "git@github.com:me/api.git" }, { repoUrl: "https://x/y" }]),
    "clone",
  );
});

test("mixed repos report the weaker claim", () => {
  // One mounted repo means the run saw someone's working tree, which is the
  // less reproducible of the two and the one worth saying out loud.
  assert.equal(
    sourceFor([{ repoUrl: "git@github.com:me/api.git" }, { repoUrl: null }]),
    "mount",
  );
});

test("no repos at all is not a mount", () => {
  // A services-only stack. Nothing was mounted, so claiming a working tree
  // would be inventing evidence.
  assert.equal(sourceFor([]), "clone");
});
