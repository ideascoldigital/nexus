-- One row per long-running command a sandbox can start.
--
-- Sandboxes had a single `Sandbox.previewUrl` and one pair of PID files on the
-- box (/tmp/nexux-app.pid, /tmp/nexux-tunnel.pid), so a project with a web app
-- *and* a functions emulator could only run one of them: the second start
-- killed the first, and the run command was resolved from the main repo only.
--
-- `key` is stable across restarts and derives the remote paths
-- (/tmp/nexux-proc-<key>.{pid,log}) so each process is killed by its own
-- recorded PID rather than by pattern. It is "<stackNodeId>#<i>" for a canvas
-- node's phases, or "repo-<repositoryId>" for a repo with no node.
--
-- `Sandbox.previewUrl` is kept and now mirrors whichever process holds a
-- tunnel, so existing readers (PR bodies, the sandbox row's preview pill) work
-- unchanged.
CREATE TABLE "SandboxProcess" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sandboxId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "repositoryId" TEXT,
    "command" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "port" INTEGER,
    "role" TEXT NOT NULL DEFAULT 'run',
    "status" TEXT NOT NULL DEFAULT 'stopped',
    "pid" INTEGER,
    "previewUrl" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SandboxProcess_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SandboxProcess_sandboxId_key_key" ON "SandboxProcess"("sandboxId", "key");
CREATE INDEX "SandboxProcess_sandboxId_idx" ON "SandboxProcess"("sandboxId");
