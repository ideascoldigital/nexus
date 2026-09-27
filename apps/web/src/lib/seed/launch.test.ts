import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";

import { testDbDir } from "../../app/api/routes.test-setup";
import { prisma } from "@nexux/db";

import { pushSeedsWhenReachable, seedsForLaunch } from "./launch";

let projectId: string;
let dbNode: string;
let otherNode: string;

before(async () => {
  const ws = await prisma.workspace.create({ data: { name: "ws-seed-launch" } });
  projectId = (await prisma.project.create({ data: { name: "p", workspaceId: ws.id } })).id;
  dbNode = (await prisma.stackNode.create({ data: { projectId, kind: "service", name: "db", image: "postgres:17" } })).id;
  otherNode = (await prisma.stackNode.create({ data: { projectId, kind: "service", name: "db2", image: "postgres:17" } })).id;
});

async function seedFor(nodeId: string, opts: { enabled?: boolean; writeFile?: boolean } = {}) {
  const row = await prisma.seedData.create({
    data: {
      projectId,
      stackNodeId: nodeId,
      fileName: "dump.sql.gz",
      format: "pg-sql",
      gzipped: true,
      sizeBytes: BigInt(4),
      sha256: "b".repeat(64),
      enabled: opts.enabled ?? true,
    },
  });
  if (opts.writeFile !== false) {
    const dir = path.join(testDbDir, "seeds", projectId, row.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "dump.sql.gz"), "data");
  }
  return row;
}

test("only enabled seeds of services this sandbox runs, named by their compose service", async () => {
  await prisma.seedData.deleteMany({ where: { projectId } });
  await seedFor(dbNode);
  await seedFor(otherNode, { enabled: false });
  const warnings: string[] = [];
  const seeds = await seedsForLaunch(projectId, [{ name: "db-1", nodeId: dbNode, image: "postgres:17", ports: [] }], (w) => warnings.push(w));
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].spec.service, "db-1");
  assert.equal(seeds[0].spec.gzipped, true);
  assert.ok(fs.existsSync(path.join(seeds[0].localDir, "dump.sql.gz")));
  assert.deepEqual(warnings, []);
});

test("a seed whose file is gone is dropped with a warning, not waited on", async () => {
  await prisma.seedData.deleteMany({ where: { projectId } });
  await seedFor(dbNode, { writeFile: false });
  const warnings: string[] = [];
  const seeds = await seedsForLaunch(projectId, [{ name: "db", nodeId: dbNode, image: "postgres:17", ports: [] }], (w) => warnings.push(w));
  assert.deepEqual(seeds, []);
  assert.match(warnings[0], /missing on this machine/);
});

test("no services, no seeds", async () => {
  assert.deepEqual(await seedsForLaunch(projectId, [], () => undefined), []);
});

test("a VM push stops quietly when the sandbox goes away", async () => {
  const logs: string[] = [];
  const ok = await pushSeedsWhenReachable([], async () => null, (l) => logs.push(l), { attempts: 3, intervalMs: 1 });
  assert.equal(ok, false);
  assert.deepEqual(logs, [], "gone is not an error to report");
});
