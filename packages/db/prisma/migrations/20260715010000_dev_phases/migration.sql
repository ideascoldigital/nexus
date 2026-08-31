-- CreateTable: development roadmap phases, AI-proposed from the definition
CREATE TABLE "DevPhase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "sourceSectionKeys" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DevPhase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DevPhase_projectId_order_idx" ON "DevPhase"("projectId", "order");

-- AlterTable: features join a dev phase and remember their definition sources
ALTER TABLE "Feature" ADD COLUMN "devPhaseId" TEXT REFERENCES "DevPhase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Feature" ADD COLUMN "sourceSectionKeys" JSONB;

-- CreateIndex
CREATE INDEX "Feature_devPhaseId_idx" ON "Feature"("devPhaseId");
