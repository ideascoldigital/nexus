-- GitLab issues, cached locally so the import/link UI can filter and search
-- without a network round-trip per keystroke — the same shape GitHubIssue and
-- ClickUpTask use. FeatureGitLabIssue mirrors FeatureIssue: provenance +
-- linking between a Nexux Feature and the GitLab issue it came from.
--
-- The account is a ConnectedAccount with providerType "gitlab"; its
-- metadata.baseUrl names the instance, so one Nexux install can talk to
-- gitlab.com and any number of self-hosted servers at once.

-- CreateTable
CREATE TABLE "GitLabIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "projectPath" TEXT NOT NULL,
    "issueIid" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" TEXT NOT NULL,
    "labels" JSONB,
    "url" TEXT NOT NULL,
    "author" TEXT,
    "assignees" JSONB,
    "milestone" TEXT,
    "closedAt" DATETIME,
    "gitlabCreatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitLabIssue_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeatureGitLabIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureGitLabIssue_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeatureGitLabIssue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "GitLabIssue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GitLabIssue_accountId_projectId_issueIid_key" ON "GitLabIssue"("accountId", "projectId", "issueIid");

-- CreateIndex
CREATE INDEX "GitLabIssue_accountId_idx" ON "GitLabIssue"("accountId");

-- CreateIndex
CREATE INDEX "GitLabIssue_state_idx" ON "GitLabIssue"("state");

-- CreateIndex
CREATE INDEX "GitLabIssue_projectId_idx" ON "GitLabIssue"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureGitLabIssue_featureId_issueId_key" ON "FeatureGitLabIssue"("featureId", "issueId");

-- CreateIndex
CREATE INDEX "FeatureGitLabIssue_featureId_idx" ON "FeatureGitLabIssue"("featureId");

-- CreateIndex
CREATE INDEX "FeatureGitLabIssue_issueId_idx" ON "FeatureGitLabIssue"("issueId");
