/**
 * SSH access to a Nexus host. Spec: `specs/19-nexus-host-provisioning.md`.
 *
 * The two decisions worth pinning down are which login the host accepts and
 * which of its two addresses to use — both change with the host's state, and
 * both are wrong in a way that only shows up as a hung or refused connection.
 * `ensureHostSshAccess` is covered end-to-end against a throwaway HOME, since
 * its whole job is the files it writes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

// Above the import below: it points HOME and NEXUX_DATA_DIR at throwaway dirs,
// which the module under test resolves through @nexux/config.
import { testDataDir, testHomeDir } from "./host-ssh.test-setup";
import { ensureHostSshAccess, hostSshAddress, hostSshUser } from "./host-ssh";

after(() => {
  fs.rmSync(testHomeDir, { recursive: true, force: true });
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const HOST = {
  name: "nexus-host",
  status: "running",
  provider: "civo",
  publicIp: "1.2.3.4",
  tailscaleIp: "100.64.0.1",
  tailscaleName: "nexus-host.tail1234.ts.net",
};

// --- hostSshUser ------------------------------------------------------------

test("a bootstrapped host is reached as root on every provider", () => {
  // The bootstrap rewrites /root/.ssh/authorized_keys with Nexus's key, so
  // root works even on AWS images that ship refusing it.
  assert.equal(hostSshUser({ status: "running", provider: "aws" }), "root");
  assert.equal(hostSshUser({ status: "running", provider: "civo" }), "root");
});

test("before bootstrap finishes, the provider's initial account is used", () => {
  // Until cloud-init replaces it, AWS answers root with `Please login as the
  // user "ubuntu"` — connecting as root there fails outright.
  assert.equal(
    hostSshUser({ status: "bootstrapping", provider: "aws" }),
    "ubuntu",
  );
  assert.equal(
    hostSshUser({ status: "provisioning", provider: "civo" }),
    "root",
  );
});

// --- hostSshAddress ---------------------------------------------------------

test("the tailnet address wins over the public IP", () => {
  assert.deepEqual(hostSshAddress(HOST), {
    host: "100.64.0.1",
    overTailnet: true,
  });
});

test("the MagicDNS name counts as a tailnet address", () => {
  assert.deepEqual(
    hostSshAddress({ ...HOST, tailscaleIp: null }),
    { host: "nexus-host.tail1234.ts.net", overTailnet: true },
  );
});

test("without a tailnet address it falls back to the public IP", () => {
  // The case that matters: mid-bootstrap, Tailscale is not up yet and the
  // public IP is the only way in.
  assert.deepEqual(
    hostSshAddress({ ...HOST, tailscaleIp: null, tailscaleName: null }),
    { host: "1.2.3.4", overTailnet: false },
  );
});

test("a host with no address at all has no target", () => {
  assert.equal(
    hostSshAddress({ publicIp: null, tailscaleIp: null, tailscaleName: null }),
    null,
  );
  // Blank strings come back from the DB as easily as nulls do.
  assert.equal(
    hostSshAddress({ publicIp: "  ", tailscaleIp: "", tailscaleName: null }),
    null,
  );
});

// --- ensureHostSshAccess ----------------------------------------------------

test("registering a host writes a resolvable SSH config entry", () => {
  const target = ensureHostSshAccess(HOST);
  assert.ok(target);
  assert.equal(target.alias, "nexus-host");
  assert.equal(target.host, "100.64.0.1");
  assert.equal(target.user, "root");
  assert.equal(target.overTailnet, true);
  assert.equal(target.terminalTarget, "ssh://root@100.64.0.1/");
  assert.match(target.command, /^ssh -i .+ root@100\.64\.0\.1$/);

  // The key the Host entry points at must exist, or ssh fails on a dangling
  // IdentityFile.
  assert.ok(fs.existsSync(target.privateKeyPath));

  const managed = fs.readFileSync(path.join(testDataDir, "ssh", "config"), "utf8");
  assert.match(managed, /Host nexus-host/);
  assert.match(managed, /HostName 100\.64\.0\.1/);
  assert.match(managed, /User root/);

  // ssh only reads the managed file if ~/.ssh/config Includes it.
  const userConfig = fs.readFileSync(
    path.join(testHomeDir, ".ssh", "config"),
    "utf8",
  );
  assert.match(userConfig, /^Include .+/m);
});

test("re-registering after the tailnet address appears replaces the entry", () => {
  // The realistic sequence: registered mid-bootstrap on the public IP, then
  // again once Tailscale is up. A second Host block for the same alias would
  // leave ssh using whichever came first.
  ensureHostSshAccess({
    ...HOST,
    name: "moving-host",
    tailscaleIp: null,
    tailscaleName: null,
  });
  const after = ensureHostSshAccess({ ...HOST, name: "moving-host" });
  assert.equal(after?.host, "100.64.0.1");

  const managed = fs.readFileSync(path.join(testDataDir, "ssh", "config"), "utf8");
  const blocks = managed.match(/Host moving-host$/gm) ?? [];
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(managed, /HostName 1\.2\.3\.4/);
});

test("a host with no address yet cannot be registered", () => {
  assert.equal(
    ensureHostSshAccess({
      ...HOST,
      name: "addressless-host",
      publicIp: null,
      tailscaleIp: null,
      tailscaleName: null,
    }),
    null,
  );
  const managed = fs.readFileSync(path.join(testDataDir, "ssh", "config"), "utf8");
  assert.doesNotMatch(managed, /addressless-host/);
});
