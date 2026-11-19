import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import { ensureMigrated } from "./migrate";

let root: string;
let dbPath: string;
let migrationsDir: string;

function addMigration(name: string, sql?: string) {
  const dir = path.join(migrationsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (sql !== undefined) {
    fs.writeFileSync(path.join(dir, "migration.sql"), sql);
  }
}

function appliedNames(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db.prepare("SELECT name FROM _nexux_migrations ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

function tableNames(): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nexux-migrate-"));
  dbPath = path.join(root, "data", "test.db");
  migrationsDir = path.join(root, "migrations");
  fs.mkdirSync(migrationsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing migrations dir is a warn-and-skip, not an error", () => {
  ensureMigrated(dbPath, path.join(root, "nope"));
  assert.equal(fs.existsSync(dbPath), false);
});

test("applies pending migrations in sorted order and records them", () => {
  addMigration("002_second", "CREATE TABLE two (id INTEGER PRIMARY KEY);");
  addMigration(
    "001_first",
    "CREATE TABLE one (id INTEGER PRIMARY KEY);",
  );
  ensureMigrated(dbPath, migrationsDir);

  assert.deepEqual(appliedNames(), ["001_first", "002_second"]);
  const tables = tableNames();
  assert.ok(tables.includes("one"));
  assert.ok(tables.includes("two"));
});

test("second run is a no-op for already-applied migrations", () => {
  addMigration("001_init", "CREATE TABLE t (id INTEGER PRIMARY KEY);");
  ensureMigrated(dbPath, migrationsDir);
  // Re-running the same CREATE TABLE would throw if executed again.
  ensureMigrated(dbPath, migrationsDir);
  assert.deepEqual(appliedNames(), ["001_init"]);
});

test("new migrations apply incrementally on later runs", () => {
  addMigration("001_init", "CREATE TABLE a (id INTEGER PRIMARY KEY);");
  ensureMigrated(dbPath, migrationsDir);
  addMigration("002_more", "CREATE TABLE b (id INTEGER PRIMARY KEY);");
  ensureMigrated(dbPath, migrationsDir);
  assert.deepEqual(appliedNames(), ["001_init", "002_more"]);
});

test("directories without migration.sql are skipped silently", () => {
  addMigration("001_empty");
  addMigration("002_real", "CREATE TABLE r (id INTEGER PRIMARY KEY);");
  ensureMigrated(dbPath, migrationsDir);
  assert.deepEqual(appliedNames(), ["002_real"]);
});

test("a failing migration throws and is not recorded; prior ones stick", () => {
  addMigration("001_good", "CREATE TABLE ok (id INTEGER PRIMARY KEY);");
  addMigration("002_bad", "THIS IS NOT SQL;");
  assert.throws(() => ensureMigrated(dbPath, migrationsDir));

  assert.deepEqual(appliedNames(), ["001_good"]);
  assert.ok(tableNames().includes("ok"));

  // Fixing the migration lets the run complete.
  fs.writeFileSync(
    path.join(migrationsDir, "002_bad", "migration.sql"),
    "CREATE TABLE fixed (id INTEGER PRIMARY KEY);",
  );
  ensureMigrated(dbPath, migrationsDir);
  assert.deepEqual(appliedNames(), ["001_good", "002_bad"]);
});

test("a failed statement inside one migration rolls back atomically", () => {
  addMigration(
    "001_partial",
    "CREATE TABLE half (id INTEGER PRIMARY KEY); INVALID SQL HERE;",
  );
  assert.throws(() => ensureMigrated(dbPath, migrationsDir));
  assert.ok(!tableNames().includes("half"));
  assert.deepEqual(appliedNames(), []);
});

test("concurrent processes migrate the same db without failing", () => {
  // next build's page-data workers all import the db client at once; each
  // one runs ensureMigrated against the same file. Regression test for the
  // UNIQUE-constraint race on _nexux_migrations.name.
  for (let i = 0; i < 40; i++) {
    const n = String(i).padStart(3, "0");
    addMigration(`${n}_m`, `CREATE TABLE t${n} (id INTEGER PRIMARY KEY);`);
  }
  const script = path.join(root, "run-migrate.ts");
  fs.writeFileSync(
    script,
    `import { ensureMigrated } from ${JSON.stringify(
      path.join(__dirname, "migrate.ts"),
    )};\n` + `ensureMigrated(process.argv[2], process.argv[3]);\n`,
  );
  const tsx = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
  const children = [0, 1, 2].map(() =>
    spawn(tsx, [script, dbPath, migrationsDir], { stdio: "pipe" }),
  );
  return Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolveExit, reject) => {
          let err = "";
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) =>
            code === 0
              ? resolveExit()
              : reject(new Error(`migrate exited ${code}: ${err}`)),
          );
        }),
    ),
  ).then(() => {
    assert.equal(appliedNames().length, 40);
  });
});

test("creates the db parent directory when missing", () => {
  addMigration("001_init", "CREATE TABLE t (id INTEGER PRIMARY KEY);");
  const nested = path.join(root, "deep", "nested", "db.sqlite");
  ensureMigrated(nested, migrationsDir);
  assert.ok(fs.existsSync(nested));
});

// --- sharing a database with `prisma migrate` -------------------------------

/** A database as `prisma migrate deploy` leaves it: tables built, ledger filled. */
function prismaMigrated(applied: Array<{ name: string; sql: string; rolledBack?: boolean }>) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE "_prisma_migrations" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "checksum" TEXT NOT NULL,
    "finished_at" DATETIME,
    "migration_name" TEXT NOT NULL,
    "logs" TEXT,
    "rolled_back_at" DATETIME,
    "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
  )`);
  for (const [i, m] of applied.entries()) {
    if (!m.rolledBack) db.exec(m.sql);
    db.prepare(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, rolled_back_at, started_at, applied_steps_count)
       VALUES (?, 'x', ?, ?, ?, ?, 1)`,
    ).run(`id-${i}`, 1_790_000_000_000 + i, m.name, m.rolledBack ? 1_790_000_000_000 : null, 1_790_000_000_000);
  }
  db.close();
}

test("a database migrated by prisma is adopted, not re-migrated", () => {
  const one = { name: "001_users", sql: "CREATE TABLE users (id TEXT);" };
  const two = { name: "002_posts", sql: "CREATE TABLE posts (id TEXT);" };
  addMigration(one.name, one.sql);
  addMigration(two.name, two.sql);
  prismaMigrated([one, two]);

  // Without adoption this throws on "table users already exists".
  ensureMigrated(dbPath, migrationsDir);
  assert.deepEqual(appliedNames(), ["001_users", "002_posts"]);
});

test("a rolled-back prisma row is not adopted — it runs here", () => {
  const one = { name: "001_users", sql: "CREATE TABLE users (id TEXT);" };
  addMigration(one.name, one.sql);
  prismaMigrated([{ ...one, rolledBack: true }]);

  ensureMigrated(dbPath, migrationsDir);
  assert.ok(tableNames().includes("users"));
  assert.deepEqual(appliedNames(), ["001_users"]);
});

test("what this runner applies lands in prisma's ledger too, with prisma's checksum", () => {
  const one = { name: "001_users", sql: "CREATE TABLE users (id TEXT);" };
  const newer = "CREATE TABLE posts (id TEXT);\n";
  addMigration(one.name, one.sql);
  addMigration("002_posts", newer);
  prismaMigrated([one]);

  ensureMigrated(dbPath, migrationsDir);

  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT checksum, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations WHERE migration_name = '002_posts'",
      )
      .get() as { checksum: string; finished_at: number; rolled_back_at: null; applied_steps_count: number };
    // Prisma's checksum is the sha256 of the file; a mismatch makes the next
    // `migrate deploy` refuse the database as modified.
    assert.equal(
      row.checksum,
      createHash("sha256").update(newer).digest("hex"),
    );
    assert.equal(typeof row.finished_at, "number");
    assert.equal(row.rolled_back_at, null);
    assert.equal(row.applied_steps_count, 1);
  } finally {
    db.close();
  }
});

test("a database prisma never touched gets no prisma ledger", () => {
  addMigration("001_users", "CREATE TABLE users (id TEXT);");
  ensureMigrated(dbPath, migrationsDir);
  assert.ok(!tableNames().includes("_prisma_migrations"));
});
