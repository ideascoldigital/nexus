import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { DELETE as deleteCredential } from "./credentials/[credentialId]/route";
import {
  GET as getCredentials,
  POST as createCredential,
} from "./credentials/route";
import { resolveTailscaleKey } from "@/lib/sandbox-manager";

let projectId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-cred-test", name: "Credentials" },
  });
  // POST stamps the new row with the active workspace, which normally comes
  // from a cookie — and `cookies()` throws outside a Next request scope.
  process.env.NEXUX_TEST_WORKSPACE = workspace.id;
  const project = await prisma.project.create({
    data: { name: "Main", workspaceId: workspace.id },
  });
  projectId = project.id;
});

after(async () => {
  delete process.env.NEXUX_TEST_WORKSPACE;
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.sandbox.deleteMany({});
  await prisma.cloudCredential.deleteMany({});
});

const credential = (over: Record<string, unknown> = {}) =>
  prisma.cloudCredential.create({
    data: {
      name: "civo-main",
      provider: "civo",
      workspaceId: "ws-cred-test",
      data: { token: "tok" },
      ...over,
    },
  });

const sandbox = (credentialId: string | null, status: string) =>
  prisma.sandbox.create({
    data: {
      projectId,
      name: `sbx-${status}`,
      status,
      provider: "civo",
      region: "lon1",
      size: "g3.small",
      workDir: "/tmp/sbx",
      credentialId,
    },
  });

const del = (credentialId: string) =>
  deleteCredential(new NextRequest("http://test/api/credentials"), {
    params: Promise.resolve({ credentialId }),
  });

test("deleting a credential that does not exist is a 404", async () => {
  const res = await del("no-such-credential");
  assert.equal(res.status, 404);
});

test("an unused credential is deleted", async () => {
  const cred = await credential();
  const res = await del(cred.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(
    await prisma.cloudCredential.findUnique({ where: { id: cred.id } }),
    null
  );
});

test("a credential a live sandbox still needs cannot be deleted", async () => {
  // Sandbox.credential is onDelete: SetNull, so without this guard the
  // reference would be silently nulled and terraform destroy would lose the
  // account it has to run against.
  const cred = await credential();
  await sandbox(cred.id, "running");
  const res = await del(cred.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /1 active sandbox —/);
  assert.ok(
    await prisma.cloudCredential.findUnique({ where: { id: cred.id } }),
    "the credential must survive a refused delete"
  );
});

test("the refusal counts every non-destroyed sandbox", async () => {
  const cred = await credential();
  await sandbox(cred.id, "running");
  await sandbox(cred.id, "provisioning");
  const res = await del(cred.id);
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /2 active sandboxes —/);
});

test("destroyed sandboxes no longer hold a credential", async () => {
  // Once the instance is gone the account is not needed again.
  const cred = await credential();
  await sandbox(cred.id, "destroyed");
  assert.equal((await del(cred.id)).status, 200);
});

test("another credential's sandboxes do not block the delete", async () => {
  const [mine, theirs] = await Promise.all([credential(), credential({ name: "other" })]);
  await sandbox(theirs.id, "running");
  assert.equal((await del(mine.id)).status, 200);
  assert.ok(await prisma.cloudCredential.findUnique({ where: { id: theirs.id } }));
});

test("a sandbox with no credential blocks nothing", async () => {
  const cred = await credential();
  await sandbox(null, "running");
  assert.equal((await del(cred.id)).status, 200);
});

// --- tailscale: a self-hosted control plane ---------------------------------
// A coordination server you do not administer (Headscale) has no console to
// mint an auth key from, so the credential is allowed to carry only the server
// URL and let the sandbox register interactively.

const post = (body: unknown) =>
  createCredential(
    new NextRequest("http://test/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

test("a tailscale credential may carry a control server and no key", async () => {
  const res = await post({
    provider: "tailscale",
    name: "civo tailnet",
    // Trailing slash stripped, so it matches the `--login-server` flag.
    loginServer: "https://vpn.example.com/",
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { loginServer: string; hint: string };
  assert.equal(body.loginServer, "https://vpn.example.com");
  // Masking an absent secret would render as "••••" and read like a key.
  assert.equal(body.hint, "browser login");

  const resolved = await resolveTailscaleKey(null);
  assert.deepEqual(
    { authKey: resolved?.authKey, loginServer: resolved?.loginServer },
    { authKey: null, loginServer: "https://vpn.example.com" }
  );
});

test("a tailscale credential may carry both a key and a control server", async () => {
  const res = await post({
    provider: "tailscale",
    name: "civo tailnet",
    authKey: "tskey-auth-SECRET",
    loginServer: "https://vpn.example.com",
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { hint: string };
  assert.equal(body.hint, "••••CRET", "the key must come back masked");

  const resolved = await resolveTailscaleKey(null);
  assert.equal(resolved?.authKey, "tskey-auth-SECRET");
  assert.equal(resolved?.loginServer, "https://vpn.example.com");
});

test("a tailscale credential with neither half is refused", async () => {
  const res = await post({ provider: "tailscale", name: "empty" });
  assert.equal(res.status, 400);
  assert.equal(await prisma.cloudCredential.count(), 0);
});

test("the control server has to be a URL, not a bare host", async () => {
  const res = await post({
    provider: "tailscale",
    name: "civo tailnet",
    loginServer: "vpn.example.com",
  });
  assert.equal(res.status, 400);
});

test("credentials saved before the control-server option still resolve", async () => {
  // Rows written by the old single-token schema store the key as `token`.
  const legacy = await credential({
    name: "legacy tailnet",
    provider: "tailscale",
    data: { token: "tskey-auth-OLD" },
  });
  const resolved = await resolveTailscaleKey(null);
  assert.equal(resolved?.authKey, "tskey-auth-OLD");
  assert.equal(resolved?.loginServer, null);

  // And they still read as a key in the list, not as a browser login.
  const listed = (await (await getCredentials()).json()) as {
    id: string;
    hint: string;
    loginServer: string | null;
  }[];
  const row = listed.find((c) => c.id === legacy.id);
  assert.equal(row?.hint, "••••-OLD");
  assert.equal(row?.loginServer, null);
});

test("the old single-token shape is refused rather than saved as a dud", async () => {
  // `token` is what the previous schema accepted. A row written that way today
  // would store a secret under a name the writer no longer uses — better a 400
  // than a credential that saves cleanly and joins nothing.
  const res = await post({
    provider: "tailscale",
    name: "civo tailnet",
    token: "tskey-auth-SECRET",
  });
  assert.equal(res.status, 400);
  assert.equal(await prisma.cloudCredential.count(), 0);
});

test("an explicit credential id wins over the first one saved", async () => {
  const first = await credential({
    name: "tailnet a",
    provider: "tailscale",
    data: { authKey: "tskey-auth-A" },
  });
  const second = await credential({
    name: "tailnet b",
    provider: "tailscale",
    data: { authKey: "tskey-auth-B", loginServer: "https://vpn.example.com" },
  });
  // Without an id the oldest wins — that is the "no picker" default.
  assert.equal((await resolveTailscaleKey(null))?.credentialId, first.id);
  const picked = await resolveTailscaleKey(second.id);
  assert.equal(picked?.credentialId, second.id);
  assert.equal(picked?.authKey, "tskey-auth-B");
  assert.equal(picked?.loginServer, "https://vpn.example.com");
});

test("a credential of another provider never resolves as a tailnet", async () => {
  // Sandbox configs hold a bare id; one pointing at a Civo token must not
  // hand its API key to `tailscale up`.
  const civo = await credential({ data: { token: "civo-secret" } });
  assert.equal(await resolveTailscaleKey(civo.id), null);
});

test("a deleted or unknown credential id resolves to nothing", async () => {
  await credential({
    name: "tailnet",
    provider: "tailscale",
    data: { authKey: "tskey-auth-A" },
  });
  // Deliberately not falling back to "any tailscale credential": a config
  // naming a credential that is gone should join nothing, not something else.
  assert.equal(await resolveTailscaleKey("no-such-credential"), null);
});

test("a credential carrying neither half resolves to nothing", async () => {
  // The route refuses to create one, but import upserts rows straight into the
  // table — a shell exported without its secret arrives exactly like this.
  await credential({
    name: "shell",
    provider: "tailscale",
    data: {},
  });
  assert.equal(await resolveTailscaleKey(null), null);
});

test("a blank key is treated as no key at all", async () => {
  await credential({
    name: "whitespace",
    provider: "tailscale",
    data: { authKey: "   ", loginServer: "https://vpn.example.com" },
  });
  const resolved = await resolveTailscaleKey(null);
  // Passing "   " to --authkey would fail the join with a confusing error.
  assert.equal(resolved?.authKey, null);
  assert.equal(resolved?.loginServer, "https://vpn.example.com");
});
