import fs from "fs";

/**
 * One Nexux server per database file.
 *
 * Two servers on one SQLite file do not corrupt it — SQLite locks — but they
 * corrupt each other's *work*. Each boots by settling what the previous
 * process left behind (`recoverOrphanTasks`, `recoverOrphanSandboxes`), and
 * "left behind" is judged by in-memory state, so a second server marks the
 * first one's running tasks and provisions as orphans. Both would also run
 * the task scheduler (duplicate runs) and poll Telegram (which answers the
 * second poller with 409). So a server holds `<db>.lock` for as long as it
 * runs, and a second one refuses to start rather than guess.
 *
 * Liveness is the recorded pid: a lock whose process is gone (a crash, a
 * kill -9) is stale and taken over.
 */

export type LockHolder = {
  pid: number;
  /** Where that instance serves, so the refusal can name it. */
  origin: string | null;
  startedAt: string;
};

export type LockResult =
  | { ok: true; path: string; release: () => void }
  | { ok: false; path: string; holder: LockHolder };

export function lockPathFor(dbPath: string): string {
  return `${dbPath}.lock`;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(path: string): LockHolder | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      origin: typeof parsed.origin === "string" ? parsed.origin : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

export function acquireInstanceLock(
  dbPath: string,
  opts: { origin?: string | null; pid?: number; alive?: (pid: number) => boolean } = {},
): LockResult {
  const path = lockPathFor(dbPath);
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? isAlive;
  const me: LockHolder = {
    pid,
    origin: opts.origin ?? null,
    startedAt: new Date().toISOString(),
  };

  // Two attempts: the second only after clearing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" is the atomic part: exactly one process can create the file.
      fs.writeFileSync(path, JSON.stringify(me), { flag: "wx" });
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // Only remove it if it is still ours.
        if (readHolder(path)?.pid === pid) fs.rmSync(path, { force: true });
      };
      return { ok: true, path, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readHolder(path);
    // Our own pid: a re-run of startup inside the same process.
    if (holder?.pid === pid) {
      return { ok: true, path, release: () => fs.rmSync(path, { force: true }) };
    }
    if (holder && alive(holder.pid)) return { ok: false, path, holder };
    // Dead holder, or a file too broken to name one: stale.
    fs.rmSync(path, { force: true });
  }
  const holder = readHolder(path);
  return holder
    ? { ok: false, path, holder }
    : { ok: false, path, holder: { pid: 0, origin: null, startedAt: "" } };
}

/** The refusal, worded for someone who has two windows open. */
export function describeLockConflict(res: Extract<LockResult, { ok: false }>): string {
  const where = res.holder.origin ? ` at ${res.holder.origin}` : "";
  return (
    `[instance-lock] Another Nexux is already running against this database${where} (pid ${res.holder.pid}). ` +
    `Two servers on one database mark each other's running tasks as orphaned and run scheduled tasks twice — ` +
    `stop that one first. If nothing is running, delete ${res.path}.`
  );
}
