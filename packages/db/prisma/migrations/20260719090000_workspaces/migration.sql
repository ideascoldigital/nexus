-- Workspaces: hard isolation boundary. Everything that existed lands in the
-- seeded default workspace; new workspaces start empty.
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "Workspace" ("id", "name") VALUES ('ws-default', 'Personal');

ALTER TABLE "Project" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE "Agent" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE "Skill" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws-default';
ALTER TABLE "CloudCredential" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws-default';

CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");
CREATE INDEX "Agent_workspaceId_idx" ON "Agent"("workspaceId");
CREATE INDEX "Skill_workspaceId_idx" ON "Skill"("workspaceId");
CREATE INDEX "CloudCredential_workspaceId_idx" ON "CloudCredential"("workspaceId");
