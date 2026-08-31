-- Scheduled agent tasks + ephemeral sandboxes (auto-destroy after the task)
ALTER TABLE "Sandbox" ADD COLUMN "ephemeral" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TaskSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureId" TEXT,
    "prompt" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'local',
    "ephemeral" BOOLEAN NOT NULL DEFAULT true,
    "cron" TEXT,
    "runAt" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "lastTaskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaskSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskSchedule_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskSchedule_projectId_idx" ON "TaskSchedule"("projectId");

-- CreateIndex
CREATE INDEX "TaskSchedule_enabled_nextRunAt_idx" ON "TaskSchedule"("enabled", "nextRunAt");
