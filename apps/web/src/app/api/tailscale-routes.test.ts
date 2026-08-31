import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { POST as tailscaleLogin } from "./projects/[projectId]/sandboxes/[sandboxId]/tailscale-login/route";
import { POST as retrySetup } from "./projects/[projectId]/sandboxes/[sandboxId]/retry-setup/route";
import { projectTailnet } from "@/lib/sandbox-manager";

// The registration URL is the one thing a keyless tailnet join needs a human
// for, and the bootstrap only ever *announces* it — into a log the UI keeps a
// 400-line tail of. These cover the on-demand path that makes it retrievable,
// and the guards that must run before anything is executed on a machine.

let projectId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-tailnet-test", name: "Tailnet" },
  });
  const project = await prisma.project.create({
    data: { name: "Tailnet", workspaceId: workspace.id },
  });
  projectId = project.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.sandbox.deleteMany({});
  await prisma.sandboxConfig.deleteMany({});
  await prisma.cloudCredential.deleteMany({});
});

const credential = (data: { authKey?: string; loginServer?: string }) =>
  prisma.cloudCredential.create({
    data: {
      name: "tailnet",
      provider: "tailscale",
      workspaceId: "ws-tailnet-test",
      data,
    },
  });

const config = (over: Record<string, unknown> = {}) =>
  prisma.sandboxConfig.create({
    data: { projectId, provider: "civo", ...over },
  });

const sandbox = (over: Record<string, unknown> = {}) =>
  prisma.sandbox.create({
    data: {
      projectId,
      name: "nexux-tailnet-test",
      status: "running",
      provider: "civo",
      region: "lon1",
      size: "g3.small",
      workDir: "/tmp/sbx",
      publicIp: "203.0.113.9",
      ...over,
    },
  });

const call = (sandboxId: string) =>
  tailscaleLogin(new NextRequest("http://test/api/tailscale-login", { method: "POST" }), {
    params: Promise.resolve({ projectId, sandboxId }),
  });

// --- projectTailnet ---------------------------------------------------------

test("no sandbox config at all means no tailnet", async () => {
  assert.equal(await projectTailnet(projectId), null);
});

test("a project that does not join a tailnet reports none", async () => {
  await config({ installTailscale: false });
  assert.equal(await projectTailnet(projectId), null);
});

test("a self-hosted tailnet reports its control server", async () => {
  const cred = await credential({ loginServer: "https://vpn.example.com" });
  await config({ installTailscale: true, tailscaleCredentialId: cred.id });
  assert.deepEqual(await projectTailnet(projectId), {
    loginServer: "https://vpn.example.com",
    hasAuthKey: false,
  });
});

test("a key-based tailnet reports no control server but says it has a key", async () => {
  const cred = await credential({ authKey: "tskey-auth-x" });
  await config({ installTailscale: true, tailscaleCredentialId: cred.id });
  assert.deepEqual(await projectTailnet(projectId), {
    loginServer: null,
    hasAuthKey: true,
  });
});

test("configured to join with no usable credential still reports a tailnet", async () => {
  // Deliberately not null: the refresh action is exactly what recovers from
  // this, so hiding it would hide the fix for the state it describes.
  await config({ installTailscale: true, tailscaleCredentialId: null });
  assert.deepEqual(await projectTailnet(projectId), {
    loginServer: null,
    hasAuthKey: false,
  });
});

// --- the route's guards -----------------------------------------------------

test("an unknown sandbox is a 404", async () => {
  const res = await call("no-such-sandbox");
  assert.equal(res.status, 404);
});

test("a sandbox of another project is not addressable through this one", async () => {
  const other = await prisma.project.create({
    data: { name: "Other", workspaceId: "ws-tailnet-test" },
  });
  const theirs = await prisma.sandbox.create({
    data: {
      projectId: other.id,
      name: "theirs",
      status: "running",
      provider: "civo",
      region: "lon1",
      size: "g3.small",
      workDir: "/tmp/sbx",
      publicIp: "203.0.113.10",
    },
  });
  assert.equal((await call(theirs.id)).status, 404);
});

test("a machine with no address yet is refused before anything is run", async () => {
  // 409, not 404: it exists, it is just not somewhere a command can reach.
  const pending = await sandbox({ status: "provisioning", publicIp: null });
  const res = await call(pending.id);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not reachable/);
});

test("a local container with no container id is refused too", async () => {
  const local = await sandbox({
    provider: "local",
    publicIp: null,
    instanceId: null,
  });
  assert.equal((await call(local.id)).status, 409);
});

test("a reachable sandbox whose project joins no tailnet is refused", async () => {
  // Checked before the machine is touched: there is nothing to log in to.
  const sbx = await sandbox();
  const res = await call(sbx.id);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not configured to join a tailnet/);
});

// --- retry setup ------------------------------------------------------------
// Re-runs the repo half of the bootstrap. Its guards matter more than usual:
// each unreachable repo costs ~130s of TCP timeout, so refusing early is the
// difference between a fast "approve first" and minutes spent re-failing.

const retry = (sandboxId: string) =>
  retrySetup(new NextRequest("http://test/api/retry-setup", { method: "POST" }), {
    params: Promise.resolve({ projectId, sandboxId }),
  });

test("retry: an unknown sandbox is a 404", async () => {
  assert.equal((await retry("no-such-sandbox")).status, 404);
});

test("retry: a machine with no address yet is refused before anything runs", async () => {
  const pending = await sandbox({ status: "provisioning", publicIp: null });
  const res = await retry(pending.id);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not reachable/);
});

test("retry: a sandbox still off its self-hosted tailnet is refused, with the fix", async () => {
  // The whole point: its repos are behind the tailnet, so every clone would
  // burn ~130s and fail exactly as the bootstrap already did. The message has
  // to name the actual next step rather than report a network fault.
  const cred = await credential({ loginServer: "https://vpn.example.com" });
  await config({ installTailscale: true, tailscaleCredentialId: cred.id });
  const sbx = await sandbox({ tailscaleIp: null });
  const res = await retry(sbx.id);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Approve the registration first/);
});

test("retry: a sandbox already on the tailnet is not blocked by that guard", async () => {
  const cred = await credential({ loginServer: "https://vpn.example.com" });
  await config({ installTailscale: true, tailscaleCredentialId: cred.id });
  const sbx = await sandbox({ tailscaleIp: "100.64.0.190" });
  const res = await retry(sbx.id);
  // Gets past the tailnet guard and fails later, on this project having no
  // repositories — which is the next check, not the one under test.
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no repositories/);
});

test("retry: an auth-key tailnet never waits on an approval", async () => {
  // With a key the join is synchronous, so a missing address means something
  // else and blocking on it would refuse a retry that would have worked.
  const cred = await credential({ authKey: "tskey-auth-x" });
  await config({ installTailscale: true, tailscaleCredentialId: cred.id });
  const sbx = await sandbox({ tailscaleIp: null });
  const res = await retry(sbx.id);
  assert.match((await res.json()).error, /no repositories/);
});
