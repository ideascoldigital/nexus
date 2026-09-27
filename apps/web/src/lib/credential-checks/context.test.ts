import { strict as assert } from "node:assert";
import { test } from "node:test";

import { checkRepoAccess, repoPath } from "./context";

function stub(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: string[] = [];
  const fetchFn = (async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;
  return { fetchFn, seen };
}

test("repo paths from every URL form", () => {
  assert.equal(repoPath("https://github.com/galtexpilots/webapp.git"), "galtexpilots/webapp");
  assert.equal(repoPath("git@github.com:galtexpilots/webapp.git"), "galtexpilots/webapp");
  assert.equal(repoPath("ssh://git@gitlab.acme.dev/group/sub/project"), "group/sub/project");
  assert.equal(repoPath("https://github.com/"), null);
});

test("github: push, read-only and invisible repos each get their own line", async () => {
  const s = stub({
    "https://api.github.com/repos/o/pushable": { status: 200, body: { permissions: { push: true, pull: true } } },
    "https://api.github.com/repos/o/readonly": { status: 200, body: { permissions: { push: false, pull: true } } },
    "https://api.github.com/repos/o/hidden": { status: 404 },
  });
  const lines = await checkRepoAccess(
    { provider: "github", token: "ghp_x" },
    [
      { name: "pushable", repoUrl: "https://github.com/o/pushable" },
      { name: "readonly", repoUrl: "git@github.com:o/readonly.git" },
      { name: "hidden", repoUrl: "https://github.com/o/hidden" },
      // Another host, and a folder-only repo: another credential's business.
      { name: "elsewhere", repoUrl: "https://gitlab.com/o/elsewhere" },
      { name: "local", repoUrl: null },
    ],
    { fetch: s.fetchFn },
  );
  assert.deepEqual(lines.map((l) => [l.label, l.ok]), [
    ["push to pushable", true],
    ["push to readonly", false],
    ["push to hidden", false],
  ]);
  assert.match(lines[1].detail ?? "", /read-only/);
  assert.equal(s.seen.length, 3);
});

test("gitlab: Developer can push, Reporter cannot — on the self-hosted host", async () => {
  const s = stub({
    "https://gitlab.acme.dev/api/v4/projects/team%2Fapi": { status: 200, body: { permissions: { project_access: { access_level: 30 } } } },
    "https://gitlab.acme.dev/api/v4/projects/team%2Fweb": { status: 200, body: { permissions: { group_access: { access_level: 20 } } } },
  });
  const lines = await checkRepoAccess(
    { provider: "gitlab", token: "glpat-x", registryHost: "registry.gitlab.acme.dev" },
    [
      { name: "api", repoUrl: "https://gitlab.acme.dev/team/api.git" },
      { name: "web", repoUrl: "https://gitlab.acme.dev/team/web.git" },
    ],
    { fetch: s.fetchFn },
  );
  assert.deepEqual(lines.map((l) => l.ok), [true, false]);
});

test("a project with no repo on the credential's host says so", async () => {
  const lines = await checkRepoAccess({ provider: "github", token: "x" }, [{ name: "a", repoUrl: "https://gitlab.com/o/a" }], {
    fetch: stub({}).fetchFn,
  });
  assert.equal(lines[0].ok, null);
});
