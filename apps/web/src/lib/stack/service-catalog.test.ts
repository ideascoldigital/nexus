import assert from "node:assert/strict";
import test from "node:test";

import { SERVICE_CATALOG, SERVICE_COMMANDS } from "./service-catalog";

test("every catalog key is unique", () => {
  const keys = SERVICE_CATALOG.map((s) => s.key);
  assert.deepEqual([...new Set(keys)], keys);
});

test("every service is describable in the canvas picker", () => {
  for (const service of SERVICE_CATALOG) {
    assert.ok(service.key, "key");
    assert.ok(service.name, `${service.key} name`);
    assert.ok(service.image, `${service.key} image`);
    assert.ok(service.description, `${service.key} description`);
  }
});

test("every image is pinned or explicitly floating on a known tag", () => {
  // A bare `image` with no tag silently means :latest; flag it deliberately.
  const untagged = SERVICE_CATALOG.filter((s) => !s.image.includes(":")).map(
    (s) => s.key
  );
  assert.deepEqual(untagged, ["ollama", "minio", "mailpit"]);
});

test("port mappings are positive numbers on both sides", () => {
  for (const service of SERVICE_CATALOG) {
    for (const port of service.ports) {
      assert.ok(
        Number.isInteger(port.host) && port.host > 0,
        `${service.key} host port`
      );
      assert.ok(
        Number.isInteger(port.container) && port.container > 0,
        `${service.key} container port`
      );
    }
  }
});

test("no two services claim the same host port", () => {
  // Two catalog services on one port cannot both be added to a stack.
  const seen = new Map<number, string>();
  for (const service of SERVICE_CATALOG) {
    for (const port of service.ports) {
      const owner = seen.get(port.host);
      assert.equal(
        owner,
        undefined,
        `${service.key} and ${owner} both claim host port ${port.host}`
      );
      seen.set(port.host, service.key);
    }
  }
});

test("env entries have a key and a string value", () => {
  for (const service of SERVICE_CATALOG) {
    for (const env of service.env) {
      assert.ok(env.key, `${service.key} env key`);
      assert.equal(typeof env.value, "string", `${service.key} ${env.key} value`);
    }
  }
});

test("volume mappings name a host source and an absolute container path", () => {
  for (const service of SERVICE_CATALOG) {
    for (const volume of service.volumes) {
      assert.ok(volume.host, `${service.key} volume host`);
      assert.ok(
        volume.container.startsWith("/"),
        `${service.key} container path ${volume.container} must be absolute`
      );
    }
  }
});

test("stateful services persist their data on a volume", () => {
  // Losing a database on container recreation is the failure this guards.
  for (const key of ["postgres", "mysql", "mongo"]) {
    const service = SERVICE_CATALOG.find((s) => s.key === key);
    assert.ok(service, key);
    assert.ok(service.volumes.length > 0, `${key} needs a data volume`);
  }
});

test("databases ship the credentials their image requires", () => {
  const postgres = SERVICE_CATALOG.find((s) => s.key === "postgres");
  const keys = postgres?.env.map((e) => e.key) ?? [];
  assert.ok(keys.includes("POSTGRES_PASSWORD"), "postgres needs a password");

  const mysql = SERVICE_CATALOG.find((s) => s.key === "mysql");
  const mysqlKeys = mysql?.env.map((e) => e.key) ?? [];
  assert.ok(
    mysqlKeys.includes("MYSQL_ROOT_PASSWORD"),
    "mysql refuses to start without a root password"
  );
});

test("minio's console port is exposed alongside its API port", () => {
  const minio = SERVICE_CATALOG.find((s) => s.key === "minio");
  const hosts = minio?.ports.map((p) => p.host) ?? [];
  assert.deepEqual(hosts, [9000, 9001]);
});

test("every service command belongs to a catalog service", () => {
  for (const key of Object.keys(SERVICE_COMMANDS)) {
    assert.ok(
      SERVICE_CATALOG.some((s) => s.key === key),
      `${key} has a command but is not in the catalog`
    );
  }
});

test("minio's command serves /data on the console port it exposes", () => {
  // The minio image is a no-op without an explicit server command.
  assert.equal(
    SERVICE_COMMANDS.minio,
    "server /data --console-address :9001"
  );
  const minio = SERVICE_CATALOG.find((s) => s.key === "minio");
  assert.ok(
    minio?.volumes.some((v) => v.container === "/data"),
    "minio serves the path it mounts"
  );
});
