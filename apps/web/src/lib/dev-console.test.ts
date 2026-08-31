import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdir, writeFile } from "fs/promises";
import path from "path";

// Env setup must stay above every other import — @nexux/db builds its client
// at module load against the throwaway SQLite file this configures, and
// NEXUX_DATA_DIR points the attachment staging root at the same temp dir.
import { testDbDir } from "../app/api/routes.test-setup";

import { prisma } from "@nexux/db";
import {
  resetDevSession,
  saveDevSessionId,
  type DevAttachment,
} from "./dev-console";

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

test("resetDevSession forgets the session and wipes settled dev history", async () => {
  const project = await prisma.project.create({ data: { name: "p" } });
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId: project.id,
      name: "sb-dev",
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb-dev",
      dedicated: true,
      devSessionId: "sess-1",
    },
  });

  // One staged attachment inside the dev-attachments root, one file outside.
  const attDir = path.join(testDbDir, "dev-attachments", "prompt-1");
  await mkdir(attDir, { recursive: true });
  const attFile = path.join(attDir, "shot.png");
  await writeFile(attFile, "img");
  const outsideFile = path.join(testDbDir, "unrelated.txt");
  await writeFile(outsideFile, "keep me");

  const mk = (
    status: string,
    kind = "dev",
    attachments?: DevAttachment[],
  ) =>
    prisma.sandboxTask.create({
      data: {
        sandboxId: sandbox.id,
        kind,
        prompt: "hi",
        workDir: "/tmp/sb-dev",
        status,
        attachments: attachments ?? undefined,
      },
    });

  const done = await mk("completed", "dev", [
    { name: "shot.png", mime: "image/png", size: 3, path: attFile },
  ]);
  const failed = await mk("error");
  const canceled = await mk("canceled");
  const running = await mk("running");
  const queued = await mk("queued");
  const pipeline = await mk("completed", "task");
  // A settled task whose attachment points outside the staging root must not
  // drag that path into the cleanup.
  const sneaky = await mk("completed", "dev", [
    { name: "unrelated.txt", mime: "text/plain", size: 7, path: outsideFile },
  ]);

  await resetDevSession(sandbox.id);

  const fresh = await prisma.sandbox.findUniqueOrThrow({
    where: { id: sandbox.id },
  });
  assert.equal(fresh.devSessionId, null, "session forgotten");

  const left = new Set(
    (
      await prisma.sandboxTask.findMany({
        where: { sandboxId: sandbox.id },
        select: { id: true },
      })
    ).map((t) => t.id),
  );
  for (const gone of [done, failed, canceled, sneaky]) {
    assert.ok(!left.has(gone.id), `settled dev row ${gone.status} is gone`);
  }
  assert.ok(left.has(running.id), "running prompt survives — the worker owns it");
  assert.ok(left.has(queued.id), "queued prompt survives");
  assert.ok(left.has(pipeline.id), "PR-pipeline history is untouched");

  assert.equal(await exists(attDir), false, "staged attachment dir removed");
  assert.equal(
    await exists(outsideFile),
    true,
    "paths outside the staging root are never touched",
  );
});

test("resetDevSession on an empty console only clears the session id", async () => {
  const project = await prisma.project.create({ data: { name: "p2" } });
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId: project.id,
      name: "sb-empty",
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb-empty",
      dedicated: true,
      devSessionId: "sess-2",
    },
  });

  await resetDevSession(sandbox.id);

  const fresh = await prisma.sandbox.findUniqueOrThrow({
    where: { id: sandbox.id },
  });
  assert.equal(fresh.devSessionId, null);
});

test("a run finishing after a reset cannot resurrect the old session", async () => {
  const project = await prisma.project.create({ data: { name: "cas" } });
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId: project.id,
      name: "sb-cas",
      region: "lon1",
      size: "g4s.kube.small",
      workDir: "/tmp/sb-cas",
      dedicated: true,
      devSessionId: "sess-old",
    },
  });

  // Normal completion: the run started from sess-old and hands over sess-new.
  assert.equal(await saveDevSessionId(sandbox.id, "sess-old", "sess-new"), true);

  // A reset lands while the next run (started from sess-new) is in flight…
  await resetDevSession(sandbox.id);
  // …so its completion must MISS: the console stays fresh.
  assert.equal(
    await saveDevSessionId(sandbox.id, "sess-new", "sess-late"),
    false,
    "the stale writer loses",
  );
  assert.equal(
    (await prisma.sandbox.findUniqueOrThrow({ where: { id: sandbox.id } }))
      .devSessionId,
    null,
    "reset survives the late writer",
  );

  // The NEXT run legitimately starts fresh and owns the slot again.
  assert.equal(await saveDevSessionId(sandbox.id, null, "sess-fresh"), true);
});
