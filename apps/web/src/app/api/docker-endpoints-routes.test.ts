import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listRoute, POST as createRoute } from "./docker-endpoints/route";
import {
  DELETE as deleteRoute,
  PATCH as patchRoute,
} from "./docker-endpoints/[endpointId]/route";
import { POST as checkRoute } from "./docker-endpoints/[endpointId]/check/route";

const HEALTHY = {
  ok: true,
  serverVersion: "27.3.1",
  arch: "x86_64",
  memTotalMb: 16384,
  rootless: false,
};

let projectId: string;

before(async () => {
  await prisma.workspace.upsert({
    where: { id: "ws-docker-ep" },
    update: {},
    create: { id: "ws-docker-ep", name: "Docker endpoints" },
  });
  const project = await prisma.project.create({
    data: { name: "EP", workspaceId: "ws-docker-ep" },
  });
  projectId = project.id;
});

after(async () => {
  delete process.env.NEXUX_TEST_DOCKER_PROBE;
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.sandbox.deleteMany({ where: { projectId } });
  await prisma.dockerEndpoint.deleteMany({});
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify(HEALTHY);
});

const json = (method: string, url: string, body?: unknown) =>
  new NextRequest(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const create = (body: unknown) =>
  createRoute(json("POST", "http://test/api/docker-endpoints", body));

const params = (endpointId: string) => ({ params: Promise.resolve({ endpointId }) });

function sandboxOn(dockerEndpointId: string, status: string) {
  return prisma.sandbox.create({
    data: {
      projectId,
      name: `box-${status}`,
      provider: "local",
      region: "local",
      size: "local",
      workDir: "/tmp/box",
      status,
      dockerEndpointId,
    },
  });
}

test("adding a healthy endpoint saves the normalised host and the probe facts", async () => {
  const res = await create({ name: "workstation", host: " ssh://jairo@Box:22/ " });
  assert.equal(res.status, 201);
  const row = await res.json();
  assert.equal(row.host, "ssh://jairo@box:22");
  assert.equal(row.arch, "x86_64");
  assert.equal(row.memTotalMb, 16384);
  assert.equal(row.lastError, null);
  assert.equal(row.sandboxCount, 0);

  const list = await (await listRoute()).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "workstation");
});

test("tcp:// is refused before any probe runs", async () => {
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({ ok: false, error: "should not run" });
  const res = await create({ name: "open", host: "tcp://box:2375" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Only ssh:\/\//);
  assert.equal(await prisma.dockerEndpoint.count(), 0);
});

test("a failed probe saves nothing and returns the probe's error", async () => {
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({
    ok: false,
    error: "The SSH user can't talk to Docker there",
  });
  const res = await create({ name: "workstation", host: "ssh://jairo@box" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /can't talk to Docker/);
  assert.equal(await prisma.dockerEndpoint.count(), 0);
});

test("the same host cannot be added twice", async () => {
  await create({ name: "a", host: "ssh://jairo@box" });
  const res = await create({ name: "b", host: "ssh://jairo@BOX/" });
  assert.equal(res.status, 409);
});

test("a failed re-check is recorded and keeps the last good facts", async () => {
  const row = await (await create({ name: "ws", host: "ssh://jairo@box" })).json();
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({ ok: false, error: "The host didn't answer" });
  const res = await checkRoute(json("POST", "http://test/x"), params(row.id));
  assert.equal(res.status, 200);
  const checked = await res.json();
  assert.equal(checked.lastError, "The host didn't answer");
  assert.equal(checked.arch, "x86_64");

  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({ ...HEALTHY, arch: "aarch64" });
  const again = await (await checkRoute(json("POST", "http://test/x"), params(row.id))).json();
  assert.equal(again.lastError, null);
  assert.equal(again.arch, "aarch64");
});

test("rename changes the name only", async () => {
  const row = await (await create({ name: "ws", host: "ssh://jairo@box" })).json();
  const res = await patchRoute(
    json("PATCH", "http://test/x", { name: "workstation", host: "ssh://evil@elsewhere" }),
    params(row.id),
  );
  const updated = await res.json();
  assert.equal(updated.name, "workstation");
  assert.equal(updated.host, "ssh://jairo@box");
});

test("an endpoint with live sandboxes cannot be removed; destroyed ones don't count", async () => {
  const row = await (await create({ name: "ws", host: "ssh://jairo@box" })).json();
  await sandboxOn(row.id, "running");
  const gone = await sandboxOn(row.id, "destroyed");

  const list = await (await listRoute()).json();
  assert.equal(list[0].sandboxCount, 1);

  const refused = await deleteRoute(json("DELETE", "http://test/x"), params(row.id));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /1 sandbox still runs on "ws"/);

  await prisma.sandbox.deleteMany({ where: { projectId, status: "running" } });
  const ok = await deleteRoute(json("DELETE", "http://test/x"), params(row.id));
  assert.equal(ok.status, 200);
  // History survives; the destroyed sandbox just no longer points anywhere.
  const kept = await prisma.sandbox.findUnique({ where: { id: gone.id } });
  assert.equal(kept?.dockerEndpointId, null);
});

test("unknown ids are 404", async () => {
  assert.equal((await deleteRoute(json("DELETE", "http://test/x"), params("nope"))).status, 404);
  assert.equal((await checkRoute(json("POST", "http://test/x"), params("nope"))).status, 404);
  assert.equal(
    (await patchRoute(json("PATCH", "http://test/x", { name: "x" }), params("nope"))).status,
    404,
  );
});
