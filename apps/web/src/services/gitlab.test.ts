import assert from "node:assert/strict";
import { test } from "node:test";

import "./services.test-setup";
import { normalizeBaseUrl } from "./gitlab";

// The instance URL is concatenated with `/api/v4/...` on every GitLab call, so
// whatever shape it settles into here is the shape every later request takes.
// The three things people actually paste — a browser's trailing slash, the
// `/api/v4` from the docs, a bare hostname — all have to land on one origin.

test("a bare hostname is assumed to be https", () => {
  // Self-hosted instances get typed by hand far more often than gitlab.com,
  // and nobody types the scheme. Defaulting to http would silently downgrade
  // the token on every request.
  assert.equal(normalizeBaseUrl("gitlab.acme.dev"), "https://gitlab.acme.dev");
});

test("an explicit http scheme is kept", () => {
  // A LAN instance on plain http is a real deployment, not a typo to correct.
  assert.equal(
    normalizeBaseUrl("http://gl.internal:8080/gitlab/"),
    "http://gl.internal:8080/gitlab",
  );
});

test("a trailing slash is dropped", () => {
  // Keeping it yields `//api/v4`, which GitLab does not route.
  assert.equal(
    normalizeBaseUrl("https://gitlab.acme.dev/"),
    "https://gitlab.acme.dev",
  );
});

test("repeated trailing slashes are all dropped", () => {
  assert.equal(normalizeBaseUrl("https://gitlab.com///"), "https://gitlab.com");
});

test("the /api/v4 suffix people copy from the docs is removed", () => {
  // Left on, the caller builds `/api/v4/api/v4/projects` and every call 404s.
  assert.equal(
    normalizeBaseUrl("https://gitlab.acme.dev/api/v4"),
    "https://gitlab.acme.dev",
  );
});

test("the /api/v4 suffix is removed regardless of case", () => {
  assert.equal(
    normalizeBaseUrl("https://gitlab.acme.dev/API/V4"),
    "https://gitlab.acme.dev",
  );
});

test("a trailing slash after /api/v4 does not hide the suffix", () => {
  // The slash is stripped first, so the suffix is still recognised.
  assert.equal(
    normalizeBaseUrl("https://gitlab.acme.dev/api/v4/"),
    "https://gitlab.acme.dev",
  );
});

test("an install under a subpath keeps that subpath", () => {
  // Dropping it would point every call at the domain root, where no GitLab
  // lives. Only the API suffix comes off, not the mount point.
  assert.equal(
    normalizeBaseUrl("https://gitlab.acme.dev/gitlab/api/v4"),
    "https://gitlab.acme.dev/gitlab",
  );
});

test("surrounding whitespace from a paste is ignored", () => {
  assert.equal(
    normalizeBaseUrl("  gitlab.acme.dev  "),
    "https://gitlab.acme.dev",
  );
});

test("the host is lowercased, so one instance is one base URL", () => {
  // Two spellings of the same host would otherwise read as two instances.
  assert.equal(
    normalizeBaseUrl("HTTPS://GitLab.ACME.dev"),
    "https://gitlab.acme.dev",
  );
});

test("credentials, query and fragment are dropped from the origin", () => {
  // A pasted URL can carry a session's query string or embedded credentials;
  // neither belongs on every subsequent API call.
  assert.equal(
    normalizeBaseUrl("https://u:p@gitlab.acme.dev/x?q=1#f"),
    "https://gitlab.acme.dev/x",
  );
});

test("an empty URL is rejected rather than defaulted", () => {
  // Silently falling back to gitlab.com would send a self-hosted token to a
  // host the user never named.
  assert.throws(() => normalizeBaseUrl(""), /A GitLab URL is required/);
});

test("a whitespace-only URL is rejected too", () => {
  assert.throws(() => normalizeBaseUrl("   "), /A GitLab URL is required/);
});

test("a scheme with no host is rejected", () => {
  assert.throws(
    () => normalizeBaseUrl("http://"),
    /Not a valid GitLab URL: http:\/\//,
  );
});

test("the rejection quotes what was typed", () => {
  // The message is shown in the connect form; echoing the input is what makes
  // a typo visible.
  assert.throws(
    () => normalizeBaseUrl("not a url"),
    /Not a valid GitLab URL: not a url/,
  );
});
