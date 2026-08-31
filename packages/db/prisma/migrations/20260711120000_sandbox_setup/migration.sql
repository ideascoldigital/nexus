-- CreateTable
CREATE TABLE "RepositorySetup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "installCommand" TEXT,
    "buildCommand" TEXT,
    "runCommand" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RepositorySetup_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectEnvVar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectEnvVar_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectEnvVar_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SandboxConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'NYC1',
    "size" TEXT NOT NULL DEFAULT 'g3.medium',
    "diskImage" TEXT NOT NULL DEFAULT 'ubuntu-jammy',
    "sshPublicKey" TEXT,
    "installDocker" BOOLEAN NOT NULL DEFAULT true,
    "installNode" BOOLEAN NOT NULL DEFAULT true,
    "installClaudeCode" BOOLEAN NOT NULL DEFAULT true,
    "installAgentBrowser" BOOLEAN NOT NULL DEFAULT true,
    "setupScript" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SandboxConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Sandbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'civo',
    "region" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "instanceId" TEXT,
    "publicIp" TEXT,
    "workDir" TEXT NOT NULL,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "destroyedAt" DATETIME,
    CONSTRAINT "Sandbox_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RepositorySetup_repositoryId_key" ON "RepositorySetup"("repositoryId");

-- CreateIndex
CREATE INDEX "ProjectEnvVar_projectId_idx" ON "ProjectEnvVar"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxConfig_projectId_key" ON "SandboxConfig"("projectId");

-- CreateIndex
CREATE INDEX "Sandbox_projectId_idx" ON "Sandbox"("projectId");
