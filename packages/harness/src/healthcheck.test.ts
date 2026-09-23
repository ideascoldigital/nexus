import { strict as assert } from "node:assert";
import { test } from "node:test";

import { healthcheckFor } from "./healthcheck";

test("the catalog's own images are all recognized", () => {
  // Every service the Stack sidebar offers must get a real readiness probe:
  // these are exactly the images a project drags in and then expects its
  // install to be able to reach.
  for (const image of [
    "postgres:17",
    "mysql:8",
    "redis:7",
    "mongo:8",
    "minio/minio",
    "ollama/ollama",
  ]) {
    assert.ok(healthcheckFor(image), `no healthcheck for ${image}`);
  }
});

test("the probe asks the protocol, not the port", () => {
  // A listening socket is what --wait already effectively checks, and it is
  // the state that lies — postgres binds before it accepts connections.
  assert.match(healthcheckFor("postgres:17")!.test[1], /pg_isready/);
  assert.match(healthcheckFor("redis:7")!.test[1], /redis-cli ping/);
  assert.match(healthcheckFor("mongo:8")!.test[1], /adminCommand/);
  assert.match(healthcheckFor("minio/minio")!.test[1], /health\/live/);
});

test("a hand-typed image gets the same probe as a catalog one", () => {
  // The healthcheck is derived from the image, not from which catalog entry a
  // node was created from — a StackNode does not persist that, and a user may
  // type their own tag.
  const typed = healthcheckFor("postgres:16-alpine");
  assert.ok(typed);
  assert.deepEqual(typed, healthcheckFor("postgres:17"));
});

test("a private registry and a digest still resolve", () => {
  assert.ok(healthcheckFor("registry.example.com:5000/postgres:17"));
  assert.ok(healthcheckFor("postgres@sha256:abc123"));
  // The registry's port colon must not be read as a tag.
  assert.ok(healthcheckFor("registry.example.com:5000/library/redis:7"));
});

test("image families that ship the same tooling are covered", () => {
  // postgis and pgvector are postgres images; valkey is a redis fork.
  assert.match(healthcheckFor("postgis/postgis:17-3.5")!.test[1], /pg_isready/);
  assert.match(healthcheckFor("pgvector/pgvector:pg17")!.test[1], /pg_isready/);
  assert.match(healthcheckFor("valkey/valkey:8")!.test[1], /redis-cli/);
  assert.match(healthcheckFor("mariadb:11")!.test[1], /ping/);
});

test("an unrecognized image gets nothing, deliberately", () => {
  // Null is a real answer: a generic port probe tells us no more than --wait
  // already does, and a guessed probe can mark a healthy service unhealthy
  // and block the whole `up`.
  assert.equal(healthcheckFor("acme/proprietary-thing:1"), null);
  assert.equal(healthcheckFor("nginx:1.27"), null);
  assert.equal(healthcheckFor(null), null);
  assert.equal(healthcheckFor(undefined), null);
  assert.equal(healthcheckFor("  "), null);
});

test("a name that merely contains a known word is not matched", () => {
  // "my-postgres-proxy" is not a postgres image, and probing it with
  // pg_isready would report a working proxy as permanently unhealthy.
  assert.equal(healthcheckFor("acme/not-redis-at-all"), null);
  assert.equal(healthcheckFor("acme/mypostgres"), null);
});

test("the probe reads the container's own env, not a baked-in default", () => {
  // A project that renamed POSTGRES_USER must still probe as the right user.
  const test0 = healthcheckFor("postgres:17")!;
  assert.equal(test0.test[0], "CMD-SHELL");
  assert.match(test0.test[1], /\$\{POSTGRES_USER:-postgres\}/);
});

test("timing leaves room for a cold first boot", () => {
  const hc = healthcheckFor("postgres:17")!;
  // start_period is what keeps a fresh data directory from being reported
  // unhealthy: inside it a failing probe does not count against retries.
  assert.equal(hc.start_period, "30s");
  // …and the whole budget stays inside the bootstrap's --wait-timeout 180.
  const seconds = (v: string) => Number(v.replace("s", ""));
  assert.ok(
    seconds(hc.start_period) + seconds(hc.interval) * hc.retries < 180,
    "the healthcheck budget exceeds the bootstrap's --wait-timeout",
  );
});
