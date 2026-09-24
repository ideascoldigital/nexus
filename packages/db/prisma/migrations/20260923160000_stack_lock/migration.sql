-- StackLock: what a green validation passed against (spec 25 piece 3).
-- Append-only by design — the lock exists to be diffed against an earlier one.
CREATE TABLE "StackLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "lockVersion" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sandboxId" TEXT,
    "repos" JSONB NOT NULL,
    "services" JSONB NOT NULL,
    "tooling" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StackLock_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Reads are always "the locks for this project, newest first".
CREATE INDEX "StackLock_projectId_createdAt_idx" ON "StackLock"("projectId", "createdAt");
