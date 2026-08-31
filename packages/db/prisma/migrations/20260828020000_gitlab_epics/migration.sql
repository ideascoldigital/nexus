-- GitLab epics: group-level bodies of work, one step above issues. An epic maps
-- onto a Nexux DevPhase almost exactly — a titled, described chunk of work that
-- spans repositories — which is what makes it worth caching rather than reading
-- live at import time.
--
-- Keyed on GitLab's global epic id, not on (group, iid): an iid is unique only
-- inside its own group, and references cross groups routinely.

-- CreateTable
CREATE TABLE "GitLabEpic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "epicId" INTEGER NOT NULL,
    "epicIid" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "groupPath" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" TEXT NOT NULL,
    "labels" JSONB,
    "url" TEXT NOT NULL,
    "author" TEXT,
    "parentId" INTEGER,
    "startDate" DATETIME,
    "dueDate" DATETIME,
    "closedAt" DATETIME,
    "gitlabCreatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitLabEpic_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GitLabEpic_accountId_epicId_key" ON "GitLabEpic"("accountId", "epicId");

-- CreateIndex
CREATE INDEX "GitLabEpic_accountId_groupId_idx" ON "GitLabEpic"("accountId", "groupId");

-- CreateIndex
CREATE INDEX "GitLabEpic_state_idx" ON "GitLabEpic"("state");

-- The epic an issue hangs off, denormalized from the issue payload. The epic
-- often belongs to a group the user never synced, so a foreign key would drop
-- the reference exactly where it is most useful.
-- AlterTable
ALTER TABLE "GitLabIssue" ADD COLUMN "epicId" INTEGER;
ALTER TABLE "GitLabIssue" ADD COLUMN "epicIid" INTEGER;
ALTER TABLE "GitLabIssue" ADD COLUMN "epicGroupId" INTEGER;
ALTER TABLE "GitLabIssue" ADD COLUMN "epicTitle" TEXT;

-- CreateIndex
CREATE INDEX "GitLabIssue_accountId_epicId_idx" ON "GitLabIssue"("accountId", "epicId");

-- CreateIndex
CREATE INDEX "GitLabIssue_accountId_projectPath_idx" ON "GitLabIssue"("accountId", "projectPath");
