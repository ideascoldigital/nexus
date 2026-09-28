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
import { POST as launchRoute } from "./projects/[projectId]/sandboxes/route";

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
  await prisma.repository.deleteMany({ where: { projectId } });
  await prisma.nexusHost.deleteMany({});
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

// --- launching onto an endpoint ---------------------------------------------

const launch = (body: unknown) =>
  launchRoute(json("POST", `http://test/api/projects/${projectId}/sandboxes`, body), {
    params: Promise.resolve({ projectId }),
  });

test("a repo with only a local folder can't launch on another machine, and the repo is named", async () => {
  const ep = await (await create({ name: "omarchy", host: "ssh://omarchy" })).json();
  await prisma.repository.create({
    data: { projectId, name: "landing", localPath: "/Users/me/landing" },
  });
  const res = await launch({ provider: "local", dockerEndpointId: ep.id });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.match(error, /"omarchy" can't see local folders: landing/);
  // Refused before anything was created or any daemon was asked.
  assert.equal(await prisma.sandbox.count({ where: { projectId } }), 0);
});

test("an endpoint on a cloud launch is refused, and so is a stale one", async () => {
  const ep = await (await create({ name: "omarchy", host: "ssh://omarchy" })).json();
  const cloud = await launch({ provider: "civo", dockerEndpointId: ep.id });
  assert.equal(cloud.status, 400);
  assert.match((await cloud.json()).error, /only applies to local sandboxes/);

  const stale = await launch({ provider: "local", dockerEndpointId: "gone" });
  assert.equal(stale.status, 400);
  assert.match((await stale.json()).error, /no longer exists/);
});

// --- Nexus hosts on an endpoint (spec 27) -----------------------------------

function hostOn(dockerEndpointId: string, status: string) {
  return prisma.nexusHost.create({
    data: {
      name: `host-${status}`,
      status,
      provider: "docker-endpoint",
      region: "omarchy",
      size: "docker",
      imageRef: "ghcr.io/o/r:latest",
      workDir: "/tmp/host",
      dockerEndpointId,
    },
  });
}

test("an endpoint running a Nexus host cannot be removed", async () => {
  const ep = await (await create({ name: "omarchy", host: "ssh://omarchy" })).json();
  await hostOn(ep.id, "running");

  const list = await (await listRoute()).json();
  assert.equal(list[0].hostCount, 1);

  const refused = await deleteRoute(json("DELETE", "http://test/x"), params(ep.id));
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /1 Nexus host still runs on "omarchy"/);
});

test("a destroyed host keeps its row and lets the endpoint go", async () => {
  const ep = await (await create({ name: "omarchy", host: "ssh://omarchy" })).json();
  const gone = await hostOn(ep.id, "destroyed");

  // The FK restricts, so this only succeeds because the row is detached first.
  const ok = await deleteRoute(json("DELETE", "http://test/x"), params(ep.id));
  assert.equal(ok.status, 200);
  const kept = await prisma.nexusHost.findUnique({ where: { id: gone.id } });
  assert.equal(kept?.dockerEndpointId, null);
});

// --- a Nexus host reaching endpoints over SSH (spec 27 phase 6) -----------------

import os from "node:os";
import path from "node:path";

function asHost<T>(run: () => Promise<T>): Promise<T> {
  // HOME points at a throwaway dir: the Include line goes into ~/.ssh/config,
  // and this must never be the developer's own.
  const saved = { role: process.env.NEXUX_ROLE, home: process.env.HOME };
  process.env.NEXUX_ROLE = "host";
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "host-home-"));
  return run().finally(() => {
    if (saved.role === undefined) delete process.env.NEXUX_ROLE;
    else process.env.NEXUX_ROLE = saved.role;
    process.env.HOME = saved.home;
  });
}

const managedConfig = () => {
  const p = path.join(testDbDir, "ssh", "config");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};

test("on a host, adding an endpoint gives ssh the host's key for that address; removing it takes it away", async () => {
  await asHost(async () => {
    const res = await create({ name: "omarchy", host: "ssh://jairo@192.168.0.35" });
    assert.equal(res.status, 201);
    assert.match(managedConfig(), /^Host 192\.168\.0\.35$/m);
    assert.ok(fs.existsSync(path.join(testDbDir, "ssh", "endpoint_ed25519")), "the endpoint key exists");
    const userConfig = fs.readFileSync(path.join(process.env.HOME!, ".ssh", "config"), "utf8");
    assert.match(userConfig, new RegExp(`Include ${path.join(testDbDir, "ssh", "config")}`));

    const { id } = await res.json();
    const del = await deleteRoute(json("DELETE", `http://test/api/docker-endpoints/${id}`), params(id));
    assert.equal(del.status, 200);
    assert.doesNotMatch(managedConfig(), /192\.168\.0\.35/);
  });
});

test("on a host, an endpoint whose probe fails leaves no ssh block behind", async () => {
  process.env.NEXUX_TEST_DOCKER_PROBE = JSON.stringify({ ok: false, error: "Permission denied (publickey)" });
  await asHost(async () => {
    const res = await create({ name: "nope", host: "ssh://jairo@10.9.9.9" });
    assert.equal(res.status, 400);
    assert.doesNotMatch(managedConfig(), /10\.9\.9\.9/);
  });
});

test("on a laptop, adding an endpoint writes no ssh config at all — the user's own keys are used", async () => {
  const before = managedConfig();
  const res = await create({ name: "lan", host: "ssh://jairo@192.168.0.77" });
  assert.equal(res.status, 201);
  assert.equal(managedConfig(), before);
});
