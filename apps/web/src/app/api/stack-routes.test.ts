import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";

// Env setup must stay above every other import — the route modules reach
// @nexux/db, whose client is built (and migrated) at module load.
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import {
  GET as getStack,
  PUT as saveStack,
} from "./projects/[projectId]/stack/route";

let projectId: string;
let otherProjectId: string;
let repositoryId: string;

before(async () => {
  const workspace = await prisma.workspace.create({
    data: { id: "ws-stack-test", name: "Stack" },
  });
  const [project, other] = await Promise.all([
    prisma.project.create({ data: { name: "Main", workspaceId: workspace.id } }),
    prisma.project.create({ data: { name: "Other", workspaceId: workspace.id } }),
  ]);
  projectId = project.id;
  otherProjectId = other.id;
  const repo = await prisma.repository.create({
    data: { projectId, name: "web" },
  });
  repositoryId = repo.id;
});

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.stackEdge.deleteMany({});
  await prisma.stackNode.deleteMany({});
});

type NodeInput = Record<string, unknown>;

const node = (over: NodeInput = {}): NodeInput => ({
  id: "tmp-1",
  kind: "service",
  name: "db",
  posX: 0,
  posY: 0,
  ...over,
});

const put = (body: unknown, id = projectId) =>
  saveStack(
    new NextRequest("http://test/api/stack", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ projectId: id }) }
  );

const get = (id = projectId) =>
  getStack(new NextRequest("http://test/api/stack"), {
    params: Promise.resolve({ projectId: id }),
  });

type SavedStack = {
  nodes: { id: string; name: string; kind: string; runMode: string }[];
  edges: { id: string; sourceId: string; targetId: string }[];
};

async function saveOk(body: unknown, id = projectId): Promise<SavedStack> {
  const res = await put(body, id);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  return (await res.json()) as SavedStack;
}

// --- validation -------------------------------------------------------------

test("a payload without nodes and edges is rejected", async () => {
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ nodes: [] })).status, 400);
});

test("a node needs a name and a known kind", async () => {
  assert.equal((await put({ nodes: [node({ name: "" })], edges: [] })).status, 400);
  assert.equal(
    (await put({ nodes: [node({ kind: "database" })], edges: [] })).status,
    400
  );
});

test("an unknown run mode is rejected", async () => {
  assert.equal(
    (await put({ nodes: [node({ runMode: "podman" })], edges: [] })).status,
    400
  );
});

test("ports must be integers on both sides", async () => {
  const bad = node({ ports: [{ host: "5432", container: 5432 }] });
  assert.equal((await put({ nodes: [bad], edges: [] })).status, 400);
});

// --- creating nodes ---------------------------------------------------------

test("an empty canvas saves as empty", async () => {
  const saved = await saveOk({ nodes: [], edges: [] });
  assert.deepEqual(saved.nodes, []);
  assert.deepEqual(saved.edges, []);
});

test("a temp id becomes a real node id", async () => {
  // The client invents `tmp-*` ids for nodes it just dropped on the canvas.
  const saved = await saveOk({ nodes: [node({ id: "tmp-abc" })], edges: [] });
  assert.equal(saved.nodes.length, 1);
  assert.notEqual(saved.nodes[0].id, "tmp-abc");
  assert.equal(saved.nodes[0].name, "db");
});

test("run mode defaults to docker", async () => {
  const saved = await saveOk({ nodes: [node()], edges: [] });
  assert.equal(saved.nodes[0].runMode, "docker");
});

test("node details are persisted", async () => {
  const saved = await saveOk({
    nodes: [
      node({
        image: "postgres:17",
        command: "postgres",
        workdir: "/app",
        ports: [{ host: 5432, container: 5432 }],
        env: [{ key: "POSTGRES_DB", value: "app" }],
        volumes: [{ host: "pgdata", container: "/var/lib/postgresql/data" }],
        posX: 120,
        posY: 40,
      }),
    ],
    edges: [],
  });
  const stored = await prisma.stackNode.findUnique({
    where: { id: saved.nodes[0].id },
  });
  assert.equal(stored?.image, "postgres:17");
  assert.equal(stored?.workdir, "/app");
  assert.equal(stored?.posX, 120);
  assert.deepEqual(stored?.ports, [{ host: 5432, container: 5432 }]);
});

test("a repo node can be linked to a repository", async () => {
  const saved = await saveOk({
    nodes: [node({ kind: "repo", name: "web", repositoryId })],
    edges: [],
  });
  const stored = await prisma.stackNode.findUnique({
    where: { id: saved.nodes[0].id },
  });
  assert.equal(stored?.repositoryId, repositoryId);
});

// --- updating and deleting --------------------------------------------------

test("saving again updates a node in place instead of duplicating it", async () => {
  const first = await saveOk({ nodes: [node()], edges: [] });
  const id = first.nodes[0].id;
  const second = await saveOk({
    nodes: [node({ id, name: "renamed" })],
    edges: [],
  });
  assert.equal(second.nodes.length, 1);
  assert.equal(second.nodes[0].id, id);
  assert.equal(second.nodes[0].name, "renamed");
});

test("a node left out of the payload is deleted", async () => {
  // The canvas sends its whole state; anything absent was removed by the user.
  const first = await saveOk({
    nodes: [node({ id: "tmp-1", name: "keep" }), node({ id: "tmp-2", name: "drop" })],
    edges: [],
  });
  assert.equal(first.nodes.length, 2);
  const keep = first.nodes.find((n) => n.name === "keep")!;
  const second = await saveOk({
    nodes: [node({ id: keep.id, name: "keep" })],
    edges: [],
  });
  assert.deepEqual(
    second.nodes.map((n) => n.name),
    ["keep"]
  );
});

test("clearing the canvas deletes every node", async () => {
  await saveOk({ nodes: [node()], edges: [] });
  const cleared = await saveOk({ nodes: [], edges: [] });
  assert.deepEqual(cleared.nodes, []);
});

test("another project's nodes are never touched", async () => {
  // deleteMany runs on this project only; a shared filter would wipe the
  // other project's canvas on every save.
  const other = await saveOk({ nodes: [node({ name: "theirs" })] , edges: [] }, otherProjectId);
  assert.equal(other.nodes.length, 1);
  await saveOk({ nodes: [], edges: [] });
  const stillThere = await prisma.stackNode.findMany({
    where: { projectId: otherProjectId },
  });
  assert.equal(stillThere.length, 1);
});

// --- edges ------------------------------------------------------------------

test("an edge between two new nodes resolves both temp ids", async () => {
  const saved = await saveOk({
    nodes: [node({ id: "tmp-a", name: "api" }), node({ id: "tmp-b", name: "db" })],
    edges: [{ sourceId: "tmp-a", targetId: "tmp-b" }],
  });
  const api = saved.nodes.find((n) => n.name === "api")!;
  const db = saved.nodes.find((n) => n.name === "db")!;
  assert.equal(saved.edges.length, 1);
  assert.equal(saved.edges[0].sourceId, api.id);
  assert.equal(saved.edges[0].targetId, db.id);
});

test("a self-edge is dropped rather than stored", async () => {
  // A node depending on itself would deadlock stack startup.
  const saved = await saveOk({
    nodes: [node({ id: "tmp-a" })],
    edges: [{ sourceId: "tmp-a", targetId: "tmp-a" }],
  });
  assert.deepEqual(saved.edges, []);
});

test("edges are replaced wholesale on each save", async () => {
  const first = await saveOk({
    nodes: [node({ id: "tmp-a", name: "api" }), node({ id: "tmp-b", name: "db" })],
    edges: [{ sourceId: "tmp-a", targetId: "tmp-b" }],
  });
  assert.equal(first.edges.length, 1);
  const api = first.nodes.find((n) => n.name === "api")!;
  const db = first.nodes.find((n) => n.name === "db")!;
  const second = await saveOk({
    nodes: [node({ id: api.id, name: "api" }), node({ id: db.id, name: "db" })],
    edges: [],
  });
  assert.deepEqual(second.edges, []);
});

test("deleting a node takes its edges with it", async () => {
  const first = await saveOk({
    nodes: [node({ id: "tmp-a", name: "api" }), node({ id: "tmp-b", name: "db" })],
    edges: [{ sourceId: "tmp-a", targetId: "tmp-b" }],
  });
  const api = first.nodes.find((n) => n.name === "api")!;
  const second = await saveOk({
    nodes: [node({ id: api.id, name: "api" })],
    edges: [],
  });
  assert.deepEqual(second.edges, []);
  assert.equal(await prisma.stackEdge.count({ where: { projectId } }), 0);
});

// --- GET --------------------------------------------------------------------

test("the canvas reads back what was saved", async () => {
  await saveOk({
    nodes: [node({ id: "tmp-a", name: "api" }), node({ id: "tmp-b", name: "db" })],
    edges: [{ sourceId: "tmp-a", targetId: "tmp-b" }],
  });
  const res = await get();
  assert.equal(res.status, 200);
  const stack = (await res.json()) as SavedStack;
  assert.deepEqual(
    stack.nodes.map((n) => n.name).sort(),
    ["api", "db"]
  );
  assert.equal(stack.edges.length, 1);
});

test("an unknown project reads as an empty canvas", async () => {
  const res = await get("no-such-project");
  assert.equal(res.status, 200);
  const stack = (await res.json()) as SavedStack;
  assert.deepEqual(stack.nodes, []);
  assert.deepEqual(stack.edges, []);
});

test("a project only sees its own canvas", async () => {
  await saveOk({ nodes: [node({ name: "mine" })], edges: [] });
  await saveOk({ nodes: [node({ name: "theirs" })], edges: [] }, otherProjectId);
  const stack = (await (await get()).json()) as SavedStack;
  assert.deepEqual(
    stack.nodes.map((n) => n.name),
    ["mine"]
  );
});
