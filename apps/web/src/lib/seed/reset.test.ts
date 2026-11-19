import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";

import { testDbDir } from "../../app/api/routes.test-setup";
import { prisma } from "@nexux/db";

import { resetSandboxData, seedsForSandbox } from "./reset";

let projectId: string;
let nodeId: string;

before(async () => {
  const ws = await prisma.workspace.create({ data: { name: "ws-seed-reset" } });
  projectId = (await prisma.project.create({ data: { name: "p", workspaceId: ws.id } })).id;
  nodeId = (
    await prisma.stackNode.create({
      data: { projectId, kind: "service", name: "db", image: "postgres:17", env: [{ key: "POSTGRES_PASSWORD", value: "x" }] },
    })
  ).id;
  const seed = await prisma.seedData.create({
    data: {
      projectId,
      stackNodeId: nodeId,
      fileName: "d.sql",
      format: "pg-sql",
      sizeBytes: BigInt(1),
      sha256: "c".repeat(64),
      enabled: false, // off for launches — a reset still uses it
    },
  });
  const dir = path.join(testDbDir, "seeds", projectId, seed.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "d.sql"), "x");
});

test("a sandbox resets to the seeds of the services it runs, even ones off for launches", async () => {
  const seeds = await seedsForSandbox({ projectId, stackServices: [{ name: "db" }] });
  assert.deepEqual(seeds.map((s) => s.spec.service), ["db"]);
});

test("a sandbox without that service has nothing to reset", async () => {
  assert.deepEqual(await seedsForSandbox({ projectId, stackServices: [{ name: "cache" }] }), []);
  assert.deepEqual(await seedsForSandbox({ projectId, stackServices: null }), []);
});

test("a sandbox that is not running is refused before touching anything", async () => {
  const sb = await prisma.sandbox.create({
    data: { projectId, name: "s", status: "paused", provider: "local", region: "local", size: "docker", workDir: "/tmp/x", stackServices: [{ name: "db" }] },
  });
  await assert.rejects(() => resetSandboxData(sb.id), /paused, not running/);
});
