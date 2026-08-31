import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as getLog } from "./projects/[projectId]/sandboxes/[sandboxId]/logs/route";

let projectId: string;
let sandboxId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-sandbox-logs-test", name: "Logs" },
  });
  const project = await prisma.project.create({
    data: { name: "Logs", workspaceId: workspace.id },
  });
  projectId = project.id;
  // Deliberately NOT reachable: no instanceId, status "pending". Every test
  // here asserts what happens *before* any remote command runs, so nothing
  // ever shells out to docker or ssh.
  const sandbox = await prisma.sandbox.create({
    data: {
      projectId,
      name: "nexux-logs-test",
      status: "pending",
      provider: "local",
      region: "local",
      size: "local",
      workDir: "/opt/nexus",
    },
  });
  sandboxId = sandbox.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const call = (source: string | null, ids?: { project?: string; sandbox?: string }) => {
  const qs = source === null ? "" : `?source=${encodeURIComponent(source)}`;
  return getLog(
    new NextRequest(`http://localhost/api/logs${qs}`),
    {
      params: Promise.resolve({
        projectId: ids?.project ?? projectId,
        sandboxId: ids?.sandbox ?? sandboxId,
      }),
    },
  );
};

for (const source of ["app", "tunnel", "bootstrap", "stack", "dockerd"]) {
  test(`"${source}" is an accepted log source`, async () => {
    const res = await call(source);
    // 409 = recognised, but this sandbox is not reachable. What matters is
    // that it got past the allowlist rather than being rejected as unknown.
    assert.equal(res.status, 409);
  });
}

test("an unknown source is rejected before anything runs", async () => {
  const res = await call("secrets");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Unknown log source");
});

test("a source is never treated as a path or a command", async () => {
  // The source is interpolated into a shell string server-side, so anything
  // outside the allowlist has to be refused rather than sanitised.
  for (const evil of [
    "/etc/passwd",
    "app; id",
    "app && cat /etc/shadow",
    "../../../../etc/passwd",
    "$(id)",
    "`id`",
  ]) {
    const res = await call(evil);
    assert.equal(res.status, 400, `${evil} must be rejected`);
  }
});

test("inherited Object properties are not accepted as sources", async () => {
  // A plain `source in LOG_SOURCES` check would let these through and read
  // `undefined.command`.
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const res = await call(key);
    assert.equal(res.status, 400, `${key} must be rejected`);
  }
});

test("no source defaults to the app log", async () => {
  const res = await call(null);
  assert.equal(res.status, 409); // recognised, just unreachable
});

test("a sandbox from another project is not found", async () => {
  const other = await prisma.project.create({
    data: { name: "Other", workspaceId: "ws-sandbox-logs-test" },
  });
  const res = await call("app", { project: other.id });
  assert.equal(res.status, 404);
});
