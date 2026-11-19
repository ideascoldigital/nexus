import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const MIGRATIONS_TABLE = "_nexux_migrations";
/**
 * Prisma Migrate's own ledger, written by `prisma migrate dev|deploy` — which
 * is how the dev server's database is migrated (`pnpm db:migrate`). The native
 * sidecar migrates with this runner instead, so one database file shared by
 * both (spec: native.json) has two ledgers describing the same history.
 */
const PRISMA_TABLE = "_prisma_migrations";

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

interface AppliedRow {
  name: string;
}

export function ensureMigrated(dbPath: string, migrationsDir: string): void {
  if (!fs.existsSync(migrationsDir)) {
    console.warn(`[migrate] migrations dir not found: ${migrationsDir} — skipping`);
    return;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // Several processes may migrate the same file at once (e.g. next build's
  // page-data workers each import the db client). Wait on the lock instead of
  // failing with SQLITE_BUSY.
  db.pragma("busy_timeout = 30000");
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  // Adopt Prisma's ledger. A database migrated by `prisma migrate` has every
  // table already, and without this the runner re-applies the first migration
  // and dies on CREATE TABLE. Only finished, not-rolled-back rows count —
  // anything else Prisma itself would refuse to build on.
  const prismaLedger = tableExists(db, PRISMA_TABLE);
  if (prismaLedger) {
    const adopted = db
      .prepare(
        `INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name, applied_at)
         SELECT migration_name, datetime(finished_at / 1000, 'unixepoch')
         FROM ${PRISMA_TABLE}
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      )
      .run();
    if (adopted.changes > 0) {
      console.log(`[migrate] adopted ${adopted.changes} migration(s) from ${PRISMA_TABLE}`);
    }
  }

  const applied = new Set(
    (db.prepare(`SELECT name FROM ${MIGRATIONS_TABLE}`).all() as AppliedRow[])
      .map((r) => r.name),
  );

  const dirs = fs
    .readdirSync(migrationsDir)
    .filter((d) => {
      const p = path.join(migrationsDir, d);
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();

  const insert = db.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (name, applied_at) VALUES (?, ?)`,
  );
  const alreadyApplied = db.prepare(
    `SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE name = ?`,
  );
  // And keep it in step: a migration applied here and missing from Prisma's
  // ledger makes the next `prisma migrate deploy` re-run it and fail. The row
  // is what Prisma itself writes — its checksum is the sha256 of the file, and
  // it verifies that on every later deploy.
  const recordForPrisma = prismaLedger
    ? db.prepare(
        `INSERT INTO ${PRISMA_TABLE}
           (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
      )
    : null;

  for (const name of dirs) {
    if (applied.has(name)) continue;
    const sqlPath = path.join(migrationsDir, name, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, "utf8");
    // Immediate: take the write lock up front, then re-check — a concurrent
    // process may have applied this migration after our SELECT above.
    const tx = db.transaction(() => {
      if (alreadyApplied.get(name)) return false;
      const startedAt = Date.now();
      db.exec(sql);
      insert.run(name, new Date().toISOString());
      recordForPrisma?.run(
        randomUUID(),
        createHash("sha256").update(sql).digest("hex"),
        Date.now(),
        name,
        startedAt,
      );
      return true;
    });
    try {
      if (tx.immediate()) console.log(`[migrate] applied ${name}`);
    } catch (err) {
      console.error(`[migrate] FAILED ${name}:`, err);
      db.close();
      throw err;
    }
  }

  db.close();
}
