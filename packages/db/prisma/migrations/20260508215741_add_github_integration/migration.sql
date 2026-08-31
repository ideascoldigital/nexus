-- CreateTable
CREATE TABLE "ProjectBrain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "config" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectBrain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "command" TEXT,
    "endpoint" TEXT,
    "description" TEXT,
    "schema" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "provider" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ConnectedAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerType" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'integration',
    "label" TEXT NOT NULL,
    "authMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenType" TEXT NOT NULL DEFAULT 'Bearer',
    "expiresAt" DATETIME,
    "scope" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OAuthToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "state" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "returnUrl" TEXT,
    "metadata" JSONB,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GitHubIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" TEXT NOT NULL,
    "labels" JSONB,
    "url" TEXT NOT NULL,
    "author" TEXT,
    "assignees" JSONB,
    "milestone" TEXT,
    "closedAt" DATETIME,
    "githubCreatedAt" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubIssue_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ConnectedAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeatureIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FeatureIssue_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeatureIssue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "GitHubIssue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBrain_projectId_key" ON "ProjectBrain"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_key_key" ON "Settings"("key");

-- CreateIndex
CREATE INDEX "ConnectedAccount_providerType_idx" ON "ConnectedAccount"("providerType");

-- CreateIndex
CREATE INDEX "ConnectedAccount_status_idx" ON "ConnectedAccount"("status");

-- CreateIndex
CREATE INDEX "OAuthToken_accountId_idx" ON "OAuthToken"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthState_state_key" ON "OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_state_idx" ON "OAuthState"("state");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "GitHubIssue_accountId_idx" ON "GitHubIssue"("accountId");

-- CreateIndex
CREATE INDEX "GitHubIssue_state_idx" ON "GitHubIssue"("state");

-- CreateIndex
CREATE INDEX "GitHubIssue_owner_repo_idx" ON "GitHubIssue"("owner", "repo");

-- CreateIndex
CREATE UNIQUE INDEX "GitHubIssue_accountId_owner_repo_issueNumber_key" ON "GitHubIssue"("accountId", "owner", "repo", "issueNumber");

-- CreateIndex
CREATE INDEX "FeatureIssue_featureId_idx" ON "FeatureIssue"("featureId");

-- CreateIndex
CREATE INDEX "FeatureIssue_issueId_idx" ON "FeatureIssue"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureIssue_featureId_issueId_key" ON "FeatureIssue"("featureId", "issueId");
