import assert from "node:assert/strict";
import { test } from "node:test";

import { renderCloudInit } from "./template";
import { renderSeedRestore, seedWaitSeconds, type SandboxSeedSpec } from "./template-seed";

const pg: SandboxSeedSpec = {
  service: "db",
  fileName: "prod.sql.gz",
  format: "pg-sql",
  gzipped: true,
  sha256: "a".repeat(64),
  sizeBytes: 250 * 1024 * 1024,
};

test("a seed waits for its marker, checks the sha, and streams into the service", () => {
  const out = renderSeedRestore([pg]);
  assert.ok(out.includes("seed:db"), "reported as its own step");
  assert.ok(out.includes("/opt/nexus/.seeds/db/.ready"));
  assert.ok(out.includes("sha256sum -c"));
  assert.ok(out.includes("gunzip -c"), "gzip is undone on the way in");
  assert.ok(out.includes("exec -T db"));
  assert.ok(out.includes("psql"));
  assert.ok(out.includes("pg_isready"), "waits for the final server, not the init one");
});

test("credentials are container env references, never values", () => {
  const out = renderSeedRestore([pg, { ...pg, service: "mysql", format: "mysql-sql", gzipped: false }]);
  assert.ok(out.includes("POSTGRES_PASSWORD"));
  assert.ok(out.includes("MYSQL_ROOT_PASSWORD"));
  assert.ok(!/PGPASSWORD=[^"$\\]/.test(out), "no literal password");
});

test("each format uses its own client", () => {
  const f = (format: SandboxSeedSpec["format"]) => renderSeedRestore([{ ...pg, format, gzipped: false }]);
  assert.ok(f("pg-custom").includes("pg_restore --no-owner --no-acl"));
  assert.ok(f("mysql-sql").includes("--force"));
  assert.ok(f("mongo-archive").includes("mongorestore --quiet --archive --drop"));
  assert.ok(!f("pg-sql").includes("gunzip"), "a plain file is read as is");
});

test("postgres restores don't wait on a WAL flush per commit", () => {
  const f = (format: SandboxSeedSpec["format"]) => renderSeedRestore([{ ...pg, format, gzipped: false }]);
  assert.ok(f("pg-sql").includes("synchronous_commit=off"), "a --inserts dump is one commit per row");
  assert.ok(f("pg-custom").includes("synchronous_commit=off"));
  assert.ok(!f("mysql-sql").includes("synchronous_commit"));
});

test("a bigger seed waits longer", () => {
  assert.equal(seedWaitSeconds(0), 900);
  assert.equal(seedWaitSeconds(250 * 1024 * 1024), 900 + 3 * 60);
});

test("a service name that is not a compose name is refused", () => {
  assert.throws(() => renderSeedRestore([{ ...pg, service: "db; rm -rf /" }]), /Invalid compose service name/);
});

test("the restore sits after stack:up and before the repos", () => {
  const script = renderCloudInit({
    provider: "civo",
    name: "t",
    region: "lon1",
    size: "g3.small",
    diskImage: "ubuntu",
    sshPublicKey: "ssh-ed25519 AAAA t",
    installDocker: true,
    installNode: false,
    installClaudeCode: false,
    installAgentBrowser: false,
    installCloudflared: false,
    envVars: {},
    repos: [{ name: "app", repoUrl: "https://github.com/acme/app.git" }],
    stackComposeYaml: "services:\n  db:\n    image: postgres:17\n",
    stackServiceNames: ["db"],
    seeds: [pg],
  });
  const up = script.indexOf("stack:up");
  const seed = script.indexOf("seed:db");
  const clone = script.indexOf("acme/app.git");
  assert.ok(up > 0 && seed > up && clone > seed, `order: stack:up ${up}, seed ${seed}, clone ${clone}`);
});

test("no stack, no seed section", () => {
  const script = renderCloudInit({
    provider: "civo",
    name: "t",
    region: "lon1",
    size: "g3.small",
    diskImage: "ubuntu",
    sshPublicKey: "ssh-ed25519 AAAA t",
    installDocker: true,
    installNode: false,
    installClaudeCode: false,
    installAgentBrowser: false,
    installCloudflared: false,
    envVars: {},
    repos: [],
    seeds: [pg],
  });
  assert.ok(!script.includes("seed:db"));
});
