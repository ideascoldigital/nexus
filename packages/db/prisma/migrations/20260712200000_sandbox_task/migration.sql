-- CreateTable
CREATE TABLE "SandboxTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sandboxId" TEXT NOT NULL,
    "featureId" TEXT,
    "prompt" TEXT NOT NULL,
    "workDir" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "log" TEXT NOT NULL DEFAULT '',
    "result" TEXT,
    "costUsd" REAL,
    "durationMs" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "SandboxTask_sandboxId_fkey" FOREIGN KEY ("sandboxId") REFERENCES "Sandbox" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SandboxTask_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SandboxTask_sandboxId_idx" ON "SandboxTask"("sandboxId");

-- CreateIndex
CREATE INDEX "SandboxTask_featureId_idx" ON "SandboxTask"("featureId");
