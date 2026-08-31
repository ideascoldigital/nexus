-- ClickUp tasks, cached locally so the import/link UI can filter and search
-- without a network round-trip per keystroke — the same shape GitHubIssue
-- uses. FeatureClickUpTask mirrors FeatureIssue: provenance + linking between
-- a Nexux Feature and the ClickUp task it came from (or was attached to).

-- CreateTable
CREATE TABLE "ClickUpTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "spaceId" TEXT,
    "folderId" TEXT,
    "listId" TEXT NOT NULL,
    "listName" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT,
    "statusType" TEXT,
    "priority" TEXT,
    "dueDate" DATETIME,
    "url" TEXT NOT NULL,
    "assignees" JSONB,
    "tags" JSONB,
    "parentTaskId" TEXT,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClickUpTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeatureClickUpTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureClickUpTask_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeatureClickUpTask_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ClickUpTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ClickUpTask_accountId_taskId_key" ON "ClickUpTask"("accountId", "taskId");

-- CreateIndex
CREATE INDEX "ClickUpTask_accountId_idx" ON "ClickUpTask"("accountId");

-- CreateIndex
CREATE INDEX "ClickUpTask_listId_idx" ON "ClickUpTask"("listId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureClickUpTask_featureId_taskId_key" ON "FeatureClickUpTask"("featureId", "taskId");

-- CreateIndex
CREATE INDEX "FeatureClickUpTask_featureId_idx" ON "FeatureClickUpTask"("featureId");

-- CreateIndex
CREATE INDEX "FeatureClickUpTask_taskId_idx" ON "FeatureClickUpTask"("taskId");
