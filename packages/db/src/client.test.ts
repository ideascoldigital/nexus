import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import fs from "fs";

// Env setup must stay above ./client — the singleton reads DATABASE_URL and
// runs migrations (NEXUX_MIGRATIONS_DIR) when the module loads.
import { testDbDir } from "./client.test-setup";
import { prisma } from "./client";

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

test("auto-migration produces a queryable schema", async () => {
  const count = await prisma.project.count();
  assert.equal(count, 0);
});

test("project CRUD round-trip", async () => {
  const created = await prisma.project.create({
    data: { name: "Test Project", description: "desc" },
  });
  assert.ok(created.id);
  assert.ok(created.createdAt instanceof Date);

  const found = await prisma.project.findUnique({ where: { id: created.id } });
  assert.equal(found?.name, "Test Project");

  const updated = await prisma.project.update({
    where: { id: created.id },
    data: { name: "Renamed" },
  });
  assert.equal(updated.name, "Renamed");

  await prisma.project.delete({ where: { id: created.id } });
  assert.equal(await prisma.project.count(), 0);
});

test("repository defaults: cloneStatus pending, isMain false", async () => {
  const project = await prisma.project.create({ data: { name: "P" } });
  const repo = await prisma.repository.create({
    data: { projectId: project.id, name: "api" },
  });
  assert.equal(repo.cloneStatus, "pending");
  assert.equal(repo.isMain, false);
  await prisma.project.delete({ where: { id: project.id } });
});

test("deleting a project cascades to its repositories", async () => {
  const project = await prisma.project.create({
    data: {
      name: "Cascade",
      repositories: { create: [{ name: "web" }, { name: "api" }] },
    },
  });
  assert.equal(
    await prisma.repository.count({ where: { projectId: project.id } }),
    2,
  );

  await prisma.project.delete({ where: { id: project.id } });
  assert.equal(
    await prisma.repository.count({ where: { projectId: project.id } }),
    0,
  );
});

test("relation queries include nested records", async () => {
  const project = await prisma.project.create({
    data: {
      name: "WithRepos",
      repositories: { create: [{ name: "main", isMain: true }] },
    },
  });
  const found = await prisma.project.findUnique({
    where: { id: project.id },
    include: { repositories: true },
  });
  assert.equal(found?.repositories.length, 1);
  assert.equal(found?.repositories[0].isMain, true);
  await prisma.project.delete({ where: { id: project.id } });
});

test("prisma singleton is reused across imports", async () => {
  const again = (await import("./client")).prisma;
  assert.equal(again, prisma);
});
