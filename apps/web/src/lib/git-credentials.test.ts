import assert from "node:assert/strict";
import { test } from "node:test";

import {
  credentialLabel,
  providerOfUrl,
  tokenCreateUrl,
  webHostOfRegistry,
} from "./git-credentials";

const GITLAB = "https://gitlab.com/-/user_settings/personal_access_tokens?name=x";
const GITHUB = "https://github.com/settings/tokens/new?scopes=repo";

test("providerOfUrl maps known hosts to their credential provider", () => {
  assert.equal(providerOfUrl("https://github.com/user/repo"), "github");
  assert.equal(providerOfUrl("https://gitlab.com/group/repo"), "gitlab");
  assert.equal(providerOfUrl("https://bitbucket.org/team/repo"), "bitbucket");
});

test("providerOfUrl returns null for unknown hosts and non-URLs", () => {
  assert.equal(providerOfUrl("https://git.example.com/repo"), null);
  assert.equal(providerOfUrl("not a url"), null);
  assert.equal(providerOfUrl(null), null);
  assert.equal(providerOfUrl(""), null);
});

test("credentialLabel names the provider, not just the credential", () => {
  assert.equal(
    credentialLabel({ name: "personal", provider: "github" }),
    "personal (github)",
  );
});

test("webHostOfRegistry strips the port and the registry label", () => {
  assert.equal(webHostOfRegistry("registry.gitlab.com"), "gitlab.com");
  assert.equal(webHostOfRegistry("gitlab.acme.dev:5050"), "gitlab.acme.dev");
  assert.equal(webHostOfRegistry("  REGISTRY.ACME.DEV  "), "acme.dev");
  assert.equal(webHostOfRegistry(""), null);
  assert.equal(webHostOfRegistry(null), null);
});

test("an empty registry override leaves the public link alone", () => {
  const link = tokenCreateUrl(GITLAB, "", "registry.gitlab.com");
  assert.equal(link.url, GITLAB);
  assert.equal(link.host, "gitlab.com");
  assert.equal(link.overridden, false);
});

test("a self-hosted registry repoints the link at that instance", () => {
  const link = tokenCreateUrl(GITLAB, "registry.gitlab.acme.dev", "registry.gitlab.com");
  assert.equal(
    link.url,
    "https://gitlab.acme.dev/-/user_settings/personal_access_tokens?name=x",
  );
  assert.equal(link.host, "gitlab.acme.dev");
  assert.equal(link.overridden, true);
});

// Restating the provider's own registry is not a self-hosted install, and
// ghcr.io does not reduce to github.com — overriding here would break the
// commonest GitHub credential there is.
test("a provider's default registry never repoints the link", () => {
  for (const [base, registry, dflt] of [
    [GITHUB, "ghcr.io", "ghcr.io"],
    [GITLAB, "registry.gitlab.com", "registry.gitlab.com"],
    [GITLAB, "REGISTRY.GITLAB.COM:443", "registry.gitlab.com"],
  ] as const) {
    const link = tokenCreateUrl(base, registry, dflt);
    assert.equal(link.url, base, `${registry} should not repoint ${base}`);
    assert.equal(link.overridden, false);
  }
});

test("a registry that resolves to the public host is not an override", () => {
  const link = tokenCreateUrl(GITLAB, "registry.gitlab.com", null);
  assert.equal(link.url, GITLAB);
  assert.equal(link.overridden, false);
});

test("an unusable base or host falls back instead of producing a dead link", () => {
  assert.deepEqual(tokenCreateUrl("", "registry.acme.dev", null), {
    url: "",
    host: "",
    overridden: false,
  });
  const spaces = tokenCreateUrl(GITLAB, "registry.acme dev", null);
  assert.equal(spaces.url, GITLAB);
  assert.equal(spaces.overridden, false);
});
