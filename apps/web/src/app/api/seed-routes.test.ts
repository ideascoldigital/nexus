import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { before, beforeEach, test } from "node:test";

import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as listSeeds, POST as uploadSeed } from "./projects/[projectId]/seeds/route";
import { POST as seedFromPath } from "./projects/[projectId]/seeds/from-path/route";
import { DELETE as deleteSeed, PATCH as patchSeed } from "./projects/[projectId]/seeds/[seedId]/route";

let projectId: string;
let pgNodeId: string;
let redisNodeId: string;

before(async () => {
  const workspace = await prisma.workspace.create({ data: { name: "ws-seed-test" } });
  projectId = (await prisma.project.create({ data: { name: "Seeded", workspaceId: workspace.id } })).id;
});

beforeEach(async () => {
  await prisma.seedData.deleteMany({ where: { projectId } });
  await prisma.stackNode.deleteMany({ where: { projectId } });
  pgNodeId = (await prisma.stackNode.create({ data: { projectId, kind: "service", name: "db", image: "postgres:17" } })).id;
  redisNodeId = (await prisma.stackNode.create({ data: { projectId, kind: "service", name: "cache", image: "redis:7" } })).id;
});

const params = () => ({ params: Promise.resolve({ projectId }) });
const PG_SQL = "--\n-- PostgreSQL database dump\n--\nCREATE TABLE users (id int);\nINSERT INTO users VALUES (1);\n";

function upload(body: Uint8Array | string, q: Record<string, string>, host = "localhost:3100") {
  const url = new URL(`http://${host}/api/projects/${projectId}/seeds`);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  return uploadSeed(new NextRequest(url, { method: "POST", body: body as BodyInit, headers: { host } }), params());
}

const seedDir = (seedId: string) => path.join(testDbDir, "seeds", projectId, seedId);

test("an uploaded PostgreSQL dump becomes the service's seed, sensitive by default", async () => {
  const res = await upload(PG_SQL, { nodeId: pgNodeId, fileName: "prod backup.sql" });
  assert.equal(res.status, 201);
  const seed = await res.json();
  assert.equal(seed.format, "pg-sql");
  assert.equal(seed.sensitive, true);
  assert.equal(seed.sizeBytes, Buffer.byteLength(PG_SQL));
  assert.equal(seed.fileName, "prod_backup.sql", "a name that stays inside its directory");
  assert.equal(fs.readFileSync(path.join(seedDir(seed.id), seed.fileName), "utf8"), PG_SQL);
});

test("gzip is looked inside, and recorded", async () => {
  const res = await upload(gzipSync(Buffer.from(PG_SQL)), { nodeId: pgNodeId, fileName: "dump.sql.gz" });
  const seed = await res.json();
  assert.equal(res.status, 201, JSON.stringify(seed));
  assert.equal(seed.format, "pg-sql");
  assert.equal(seed.gzipped, true);
});

test("a dump for another engine is refused, naming both, and leaves nothing behind", async () => {
  const res = await upload("-- MySQL dump 10.13\n", { nodeId: pgNodeId, fileName: "x.sql" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /MySQL\/MariaDB SQL dump, but postgres:17 runs PostgreSQL/);
  assert.equal(await prisma.seedData.count({ where: { projectId } }), 0);
  const left = fs.readdirSync(path.join(testDbDir, "seeds", projectId)).filter((d) => d.startsWith(".incoming-"));
  assert.deepEqual(left, [], "the staging directory was removed");
});

test("a service that is not a database is refused", async () => {
  const res = await upload(PG_SQL, { nodeId: redisNodeId, fileName: "x.sql" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /redis:7 is not a database/);
});

test("uploading again replaces the seed and its file", async () => {
  const first = await (await upload(PG_SQL, { nodeId: pgNodeId, fileName: "a.sql" })).json();
  const second = await (await upload(PG_SQL + "-- more\n", { nodeId: pgNodeId, fileName: "b.sql" })).json();
  assert.notEqual(first.id, second.id);
  assert.equal(fs.existsSync(seedDir(first.id)), false, "the old file is gone");
  assert.equal(await prisma.seedData.count({ where: { projectId } }), 1);
});

test("a path on this machine is read in place — but only from this machine", async () => {
  const file = path.join(testDbDir, "local.sql");
  fs.writeFileSync(file, PG_SQL);
  const call = (host: string) =>
    seedFromPath(
      new NextRequest(`http://${host}/api/projects/${projectId}/seeds/from-path`, {
        method: "POST",
        body: JSON.stringify({ nodeId: pgNodeId, path: file, sensitive: false }),
        headers: { host, "content-type": "application/json" },
      }),
      params(),
    );
  const remote = await call("100.64.0.10:3030");
  assert.equal(remote.status, 403, "a request from the network cannot name a path on this disk");
  const local = await call("127.0.0.1:3100");
  assert.equal(local.status, 201);
  const seed = await local.json();
  assert.equal(seed.sensitive, false);
  assert.equal(seed.fileName, "local.sql");
});

test("listing reports whether a path can be picked, and sweeps a deleted node's file", async () => {
  const seed = await (await upload(PG_SQL, { nodeId: pgNodeId, fileName: "a.sql" })).json();
  await prisma.stackNode.delete({ where: { id: pgNodeId } }); // cascades the row, not the directory
  const res = await listSeeds(new NextRequest(`http://localhost:3100/api/projects/${projectId}/seeds`, { headers: { host: "localhost:3100" } }), params());
  const body = await res.json();
  assert.equal(body.canPickLocalFile, true);
  assert.deepEqual(body.seeds, []);
  assert.equal(fs.existsSync(seedDir(seed.id)), false);
});

test("sensitive and enabled can be changed; deleting removes the file", async () => {
  const seed = await (await upload(PG_SQL, { nodeId: pgNodeId, fileName: "a.sql" })).json();
  const p = { params: Promise.resolve({ projectId, seedId: seed.id }) };
  const patched = await patchSeed(
    new NextRequest("http://localhost/x", { method: "PATCH", body: JSON.stringify({ sensitive: false, enabled: false }) }),
    p,
  );
  const body = await patched.json();
  assert.equal(body.sensitive, false);
  assert.equal(body.enabled, false);
  const del = await deleteSeed(new NextRequest("http://localhost/x", { method: "DELETE" }), p);
  assert.equal(del.status, 204);
  assert.equal(fs.existsSync(seedDir(seed.id)), false);
});
