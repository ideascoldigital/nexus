import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const MIGRATIONS_TABLE = "_nexux_migrations";

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

  for (const name of dirs) {
    if (applied.has(name)) continue;
    const sqlPath = path.join(migrationsDir, name, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, "utf8");
    // Immediate: take the write lock up front, then re-check — a concurrent
    // process may have applied this migration after our SELECT above.
    const tx = db.transaction(() => {
      if (alreadyApplied.get(name)) return false;
      db.exec(sql);
      insert.run(name, new Date().toISOString());
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
