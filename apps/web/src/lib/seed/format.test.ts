import assert from "node:assert/strict";
import { test } from "node:test";

import { detectSeedFormat, engineOfImage, isGzip, seedMismatch } from "./format";

const bytes = (s: string) => new TextEncoder().encode(s);

test("the engine is read off the image's repository name", () => {
  assert.equal(engineOfImage("postgres:17"), "postgres");
  assert.equal(engineOfImage("docker.io/library/postgres:16-alpine"), "postgres");
  assert.equal(engineOfImage("postgis/postgis:16-3.4"), "postgres");
  assert.equal(engineOfImage("timescale/timescaledb:latest-pg16"), "postgres");
  assert.equal(engineOfImage("mariadb:11"), "mysql");
  assert.equal(engineOfImage("mysql:8.4"), "mysql");
  assert.equal(engineOfImage("mongo:7"), "mongo");
  assert.equal(engineOfImage("redis:7"), null);
  assert.equal(engineOfImage("ghcr.io/acme/postgres-exporter:1"), null, "a name that merely contains postgres");
  assert.equal(engineOfImage(null), null);
});

test("dumps are recognised by their tool headers", () => {
  assert.equal(detectSeedFormat(bytes("PGDMP\x01\x0f\x00"), "postgres"), "pg-custom");
  assert.equal(detectSeedFormat(bytes("--\n-- PostgreSQL database dump\n--\n"), "postgres"), "pg-sql");
  assert.equal(detectSeedFormat(bytes("--\n-- PostgreSQL database cluster dump\n"), "postgres"), "pg-sql");
  assert.equal(detectSeedFormat(bytes("-- MySQL dump 10.13  Distrib 8.0.36\n"), "mysql"), "mysql-sql");
  assert.equal(detectSeedFormat(bytes("-- MariaDB dump 10.19\n"), "mysql"), "mysql-sql");
  assert.equal(detectSeedFormat(new Uint8Array([0x6d, 0xe2, 0x99, 0x81, 1, 0, 0, 0]), "mongo"), "mongo-archive");
});

test("the header wins over the target, so a mismatch can be named", () => {
  assert.equal(detectSeedFormat(bytes("-- MySQL dump 10.13\n"), "postgres"), "mysql-sql");
  assert.match(seedMismatch("mysql-sql", "postgres", "postgres:17") ?? "", /MySQL\/MariaDB SQL dump, but postgres:17 runs PostgreSQL/);
  assert.equal(seedMismatch("pg-custom", "postgres", "postgres:17"), null);
  assert.match(seedMismatch("pg-sql", null, "redis:7") ?? "", /redis:7 is not a database/);
});

test("headerless SQL is taken as the target engine's SQL", () => {
  const sql = bytes("CREATE TABLE users (id int);\nINSERT INTO users VALUES (1);\n");
  assert.equal(detectSeedFormat(sql, "postgres"), "pg-sql");
  assert.equal(detectSeedFormat(sql, "mysql"), "mysql-sql");
  assert.equal(detectSeedFormat(sql, "mongo"), null, "SQL cannot go into Mongo");
});

test("anything else is not a dump", () => {
  assert.equal(detectSeedFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), "postgres"), null);
  assert.equal(detectSeedFormat(bytes("just some notes about the database\n"), "postgres"), null);
  assert.equal(detectSeedFormat(new Uint8Array(), "postgres"), null);
});

test("gzip is spotted by its magic", () => {
  assert.equal(isGzip(new Uint8Array([0x1f, 0x8b, 8, 0])), true);
  assert.equal(isGzip(bytes("PGDMP")), false);
});
