import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parse } from "yaml";

import { generateCompose, slugifyServiceName } from "./compose";

test("slugifyServiceName sanitizes to compose-safe names", () => {
  assert.equal(slugifyServiceName("My API (v2)"), "my-api-v2");
  assert.equal(slugifyServiceName("PostgreSQL"), "postgresql");
  assert.equal(slugifyServiceName("---"), "service");
});

test("repo node becomes build service, local node excluded", () => {
  const out = generateCompose({
    projectName: "nexux-p1",
    nodes: [
      {
        id: "a",
        kind: "repo",
        name: "api",
        runMode: "docker",
        localPath: "/repos/api",
        dockerfile: "Dockerfile.dev",
        ports: [{ host: 3000, container: 3000 }],
      },
      {
        id: "w",
        kind: "repo",
        name: "web",
        runMode: "local",
        localPath: "/repos/web",
      },
    ],
    edges: [],
  });
  const doc = parse(out.yaml);
  assert.equal(doc.name, "nexux-p1");
  assert.deepEqual(Object.keys(doc.services), ["api"]);
  assert.deepEqual(doc.services.api.build, {
    context: "/repos/api",
    dockerfile: "Dockerfile.dev",
  });
  assert.deepEqual(doc.services.api.ports, ["3000:3000"]);
});

test("edges become depends_on; edge to local node warns", () => {
  const out = generateCompose({
    projectName: "p",
    nodes: [
      {
        id: "a",
        kind: "repo",
        name: "api",
        runMode: "docker",
        localPath: "/repos/api",
      },
      { id: "db", kind: "service", name: "postgres", runMode: "docker", image: "postgres:17" },
      { id: "w", kind: "repo", name: "web", runMode: "local", localPath: "/repos/web" },
    ],
    edges: [
      { sourceId: "a", targetId: "db" },
      { sourceId: "a", targetId: "w" },
    ],
  });
  const doc = parse(out.yaml);
  assert.deepEqual(doc.services.api.depends_on, ["postgres"]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /runs locally/);
});

test("named volumes collected top-level, path volumes not", () => {
  const out = generateCompose({
    projectName: "p",
    nodes: [
      {
        id: "db",
        kind: "service",
        name: "postgres",
        runMode: "docker",
        image: "postgres:17",
        env: [{ key: "POSTGRES_PASSWORD", value: "postgres" }],
        volumes: [
          { host: "pgdata", container: "/var/lib/postgresql/data" },
          { host: "./init", container: "/docker-entrypoint-initdb.d" },
        ],
      },
    ],
    edges: [],
  });
  const doc = parse(out.yaml);
  assert.deepEqual(Object.keys(doc.volumes), ["pgdata"]);
  assert.deepEqual(doc.services.postgres.environment, {
    POSTGRES_PASSWORD: "postgres",
  });
});

test("duplicate names deduped deterministically", () => {
  const out = generateCompose({
    projectName: "p",
    nodes: [
      { id: "1", kind: "service", name: "redis", runMode: "docker", image: "redis:7" },
      { id: "2", kind: "service", name: "Redis", runMode: "docker", image: "redis:6" },
    ],
    edges: [],
  });
  const doc = parse(out.yaml);
  assert.deepEqual(Object.keys(doc.services).sort(), ["redis", "redis-2"]);
});

test("cycle in edges produces warning", () => {
  const out = generateCompose({
    projectName: "p",
    nodes: [
      { id: "a", kind: "service", name: "a", runMode: "docker", image: "x" },
      { id: "b", kind: "service", name: "b", runMode: "docker", image: "y" },
    ],
    edges: [
      { sourceId: "a", targetId: "b" },
      { sourceId: "b", targetId: "a" },
    ],
  });
  assert.ok(out.warnings.some((w) => w.includes("cycle")));
});

test("empty docker set yields empty yaml", () => {
  const out = generateCompose({
    projectName: "p",
    nodes: [
      { id: "w", kind: "repo", name: "web", runMode: "local", localPath: "/w" },
    ],
    edges: [],
  });
  assert.equal(out.yaml, "");
});
