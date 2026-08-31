-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentSkill_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentSkill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentSkill_projectId_idx" ON "AgentSkill"("projectId");

-- CreateIndex
CREATE INDEX "AgentSkill_agentId_idx" ON "AgentSkill"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_agentId_skillId_projectId_key" ON "AgentSkill"("agentId", "skillId", "projectId");
