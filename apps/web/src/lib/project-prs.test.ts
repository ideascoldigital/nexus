import assert from "node:assert/strict";
import { test } from "node:test";

import "../app/api/routes.test-setup";
import { parseRemote, tokenFor } from "./project-prs";

test("remotes are recognised on GitHub, gitlab.com and a self-hosted GitLab", () => {
  assert.deepEqual(parseRemote("https://github.com/acme/api.git"), { provider: "github", host: "github.com", path: "acme/api" });
  assert.deepEqual(parseRemote("git@github.com:acme/web.git"), { provider: "github", host: "github.com", path: "acme/web" });
  assert.deepEqual(parseRemote("https://git.civo.com/civo/colony/colony-api.git", ["git.civo.com"]), {
    provider: "gitlab",
    host: "git.civo.com",
    path: "civo/colony/colony-api",
  });
  assert.equal(parseRemote("https://git.civo.com/civo/colony/colony-api.git"), null); // unknown host, no GitLab token for it
  assert.equal(parseRemote("https://git.civo.com/civo/colony/colony-api.git", ["*"])?.provider, "gitlab"); // a GitLab token exists: try it
  assert.equal(parseRemote("not a url"), null);
});

test("the repo's own credential wins, then one for its host", () => {
  const creds = [
    { id: "gh", provider: "github", data: { token: "t-gh" } },
    { id: "gl-civo", provider: "gitlab", data: { token: "t-civo", registryHost: "git.civo.com" } },
    { id: "gl-com", provider: "gitlab", data: { token: "t-com" } },
  ];
  assert.equal(tokenFor({ provider: "github", host: "github.com", path: "a/b" }, creds, null), "t-gh");
  assert.equal(tokenFor({ provider: "gitlab", host: "git.civo.com", path: "a/b" }, creds, null), "t-civo");
  assert.equal(tokenFor({ provider: "gitlab", host: "gitlab.com", path: "a/b" }, creds, null), "t-com");
  assert.equal(tokenFor({ provider: "gitlab", host: "gitlab.com", path: "a/b" }, creds, "gl-civo"), "t-civo");
  assert.equal(tokenFor({ provider: "gitlab", host: "other.host", path: "a/b" }, creds, null), null);
});
