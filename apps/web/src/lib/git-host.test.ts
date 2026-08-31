import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gitProvidersForRepos,
  providerOfHost,
  selfHostedGitLabHost,
} from "./git-host";

// A GitLab token only authenticates gitlab.com unless GITLAB_HOST names the
// instance. Without it a self-hosted clone fails as `could not read Username
// for 'https://git.example.com'` — an error that blames the credential prompt
// rather than the missing config, which is why this is derived, not asked for.

test("a self-hosted repo names the instance", () => {
  assert.equal(
    selfHostedGitLabHost([
      "https://git.example.com/acme/dashboard/settings-micro-frontend.git",
    ]),
    "git.example.com",
  );
});

test("gitlab.com needs no host — the token already works there", () => {
  assert.equal(
    selfHostedGitLabHost(["https://gitlab.com/group/project.git"]),
    null,
  );
});

test("the ssh remote form resolves to the same host", () => {
  assert.equal(
    selfHostedGitLabHost(["git@git.example.com:acme/dashboard/app.git"]),
    "git.example.com",
  );
});

test("credentials embedded in the url do not become the host", () => {
  assert.equal(
    selfHostedGitLabHost(["https://oauth2:glpat-xxx@git.example.com/g/p.git"]),
    "git.example.com",
  );
});

test("repos on different instances resolve to nothing", () => {
  // GITLAB_HOST names one instance. Picking either would authenticate against
  // the wrong one, which surfaces as a permissions error rather than a
  // configuration one — worse than leaving it unset.
  assert.equal(
    selfHostedGitLabHost([
      "https://git.example.com/a/b.git",
      "https://git.example.org/c/d.git",
    ]),
    null,
  );
});

test("a repo with no url yet falls back to the credential's host", () => {
  // A project whose repositories are still shells has nothing to derive from.
  assert.equal(
    selfHostedGitLabHost([null, undefined, ""], "https://git.example.com/"),
    "git.example.com",
  );
  assert.equal(selfHostedGitLabHost([], "gitlab.com"), null);
  assert.equal(selfHostedGitLabHost([], null), null);
});

test("repo urls win over the credential's saved host", () => {
  // The credential may be reused across projects; the repo is this project's.
  assert.equal(
    selfHostedGitLabHost(["https://git.example.com/a/b.git"], "git.other.com"),
    "git.example.com",
  );
});

test("mixing gitlab.com with a self-hosted repo still names the instance", () => {
  // gitlab.com needs no entry, so it does not count as a conflicting host.
  assert.equal(
    selfHostedGitLabHost([
      "https://gitlab.com/group/shared.git",
      "https://git.example.com/acme/app.git",
    ]),
    "git.example.com",
  );
});

// --- gitProvidersForRepos ----------------------------------------------------
// A sandbox gets a token per host its repos actually live on. Injecting only
// the one selected credential left the other host cloning anonymously, which
// fails as `could not read Username` after the bootstrap already said it was
// done — the failure that made this function exist.

test("a project on one host needs one provider", () => {
  assert.deepEqual(
    [...gitProvidersForRepos(["https://github.com/org/app.git"])],
    ["github"],
  );
});

test("repos split across hosts need both tokens", () => {
  const providers = gitProvidersForRepos([
    "https://git.example.com/acme/group/acme-api.git",
    "https://github.com/acme-io/acme-aws.git",
  ]);
  assert.equal(providers.size, 2);
  assert.ok(providers.has("gitlab"));
  assert.ok(providers.has("github"));
});

test("an unrecognised host counts as a self-hosted GitLab", () => {
  assert.deepEqual(
    [...gitProvidersForRepos(["https://git.example.org/a/b.git"])],
    ["gitlab"],
  );
});

test("the ssh remote form resolves to the same provider", () => {
  assert.deepEqual(
    [...gitProvidersForRepos(["git@github.com:org/app.git"])],
    ["github"],
  );
});

test("bitbucket is recognised rather than read as self-hosted GitLab", () => {
  assert.deepEqual(
    [...gitProvidersForRepos(["https://bitbucket.org/team/repo.git"])],
    ["bitbucket"],
  );
});

test("repos with no url yet contribute no provider", () => {
  assert.equal(gitProvidersForRepos([null, undefined, ""]).size, 0);
});

test("the same host twice is still one provider", () => {
  assert.equal(
    gitProvidersForRepos([
      "https://github.com/org/a.git",
      "https://github.com/org/b.git",
    ]).size,
    1,
  );
});

// --- providerOfHost ----------------------------------------------------------

test("known hosts name their provider, unknown ones do not", () => {
  assert.equal(providerOfHost("github.com"), "github");
  assert.equal(providerOfHost("gitlab.com"), "gitlab");
  assert.equal(providerOfHost("bitbucket.org"), "bitbucket");
  assert.equal(providerOfHost("git.example.com"), null);
  assert.equal(providerOfHost(null), null);
});

test("a host arrives with scheme or trailing path and still resolves", () => {
  assert.equal(providerOfHost("https://github.com/"), "github");
  assert.equal(providerOfHost("GitHub.com"), "github");
});

// --- selfHostedGitLabHost, with a second known host in the mix ---------------

test("a github repo does not compete with the self-hosted instance", () => {
  // The real shape that broke: charts on github.com beside a self-hosted
  // GitLab used to read as two instances and resolve to nothing, leaving
  // GITLAB_HOST unset for the one host that needed it.
  assert.equal(
    selfHostedGitLabHost([
      "https://git.example.com/acme/group/acme-api.git",
      "https://github.com/acme-io/acme-aws.git",
    ]),
    "git.example.com",
  );
});

test("bitbucket does not compete either", () => {
  assert.equal(
    selfHostedGitLabHost([
      "https://git.example.com/a/b.git",
      "https://bitbucket.org/team/repo.git",
    ]),
    "git.example.com",
  );
});

test("two genuinely self-hosted instances still resolve to nothing", () => {
  assert.equal(
    selfHostedGitLabHost([
      "https://git.example.com/a/b.git",
      "https://git.example.org/c/d.git",
      "https://github.com/org/e.git",
    ]),
    null,
  );
});
