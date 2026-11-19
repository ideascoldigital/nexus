import assert from "node:assert/strict";
import { before, test } from "node:test";

import "../../app/api/routes.test-setup";
import { prisma } from "@nexux/db";

import { saveSandboxDataAsSeed, sandboxDatabases } from "./save";

let projectId: string;

before(async () => {
  const ws = await prisma.workspace.create({ data: { name: "ws-seed-save" } });
  projectId = (await prisma.project.create({ data: { name: "p", workspaceId: ws.id } })).id;
  const db = await prisma.stackNode.create({ data: { projectId, kind: "service", name: "db", image: "postgres:17" } });
  await prisma.stackNode.create({ data: { projectId, kind: "service", name: "cache", image: "redis:7" } });
  await prisma.seedData.create({
    data: { projectId, stackNodeId: db.id, fileName: "old.dump", format: "pg-custom", sizeBytes: BigInt(10), sha256: "f".repeat(64), sensitive: false },
  });
});

test("a sandbox's databases are its running services that are databases, with their current seed", async () => {
  const dbs = await sandboxDatabases({ projectId, stackServices: [{ name: "db" }, { name: "cache" }] });
  assert.equal(dbs.length, 1, "redis is not a database a seed goes into");
  assert.equal(dbs[0].service, "db");
  assert.equal(dbs[0].engine, "postgres");
  assert.deepEqual(dbs[0].seed, { fileName: "old.dump", sizeBytes: 10, sensitive: false });
});

test("a service the sandbox does not run is not offered", async () => {
  assert.deepEqual(await sandboxDatabases({ projectId, stackServices: [{ name: "cache" }] }), []);
});

test("saving from a sandbox that is not running is refused before dumping", async () => {
  const sb = await prisma.sandbox.create({
    data: { projectId, name: "s", status: "paused", provider: "local", region: "local", size: "docker", workDir: "/tmp/x", stackServices: [{ name: "db" }] },
  });
  await assert.rejects(() => saveSandboxDataAsSeed(sb.id, "db"), /paused, not running/);
});
