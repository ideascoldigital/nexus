import assert from "node:assert/strict";
import fs from "node:fs";
import { after, afterEach, before, test } from "node:test";

import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listRoute } from "./credentials/route";
import { POST as checkRoute } from "./credentials/[credentialId]/check/route";

const TOKEN = "ghp_" + "S".repeat(36);
const realFetch = globalThis.fetch;

before(async () => {
  await prisma.workspace.upsert({
    where: { id: "ws-cred-check" },
    update: {},
    create: { id: "ws-cred-check", name: "Cred checks" },
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const params = (credentialId: string) => ({ params: Promise.resolve({ credentialId }) });
const post = (id: string) => checkRoute(new NextRequest("http://test/x", { method: "POST" }), params(id));

test("a GitHub credential is tested, stored, and listed without its secret", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ login: "octocat" }), {
      status: 200,
      headers: { "x-oauth-scopes": "repo" },
    })) as typeof fetch;
  const cred = await prisma.cloudCredential.create({
    data: { workspaceId: "ws-cred-check", name: "gh", provider: "github", data: { token: TOKEN } },
  });

  const res = await post(cred.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.identity, "octocat");
  assert.ok(!JSON.stringify(body).includes(TOKEN));

  const listed = (await (await listRoute()).json()).find((c: { id: string }) => c.id === cred.id);
  assert.equal(listed.lastCheck.status, "ok");
  assert.ok(listed.lastCheckedAt);
  assert.ok(!JSON.stringify(listed).includes(TOKEN), "the list never carries the secret");
});

test("a provider without a check says so instead of pretending", async () => {
  const cred = await prisma.cloudCredential.create({
    data: { workspaceId: "ws-cred-check", name: "civo", provider: "civo", data: { token: "x" } },
  });
  const res = await post(cred.id);
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /isn't available yet/);
});

test("unknown ids are 404", async () => {
  assert.equal((await post("nope")).status, 404);
});
