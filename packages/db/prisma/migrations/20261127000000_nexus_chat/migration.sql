-- Spec 39: the Nexus chat is a bot of its own kind, one per project.
ALTER TABLE "Bot" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'bot';
ALTER TABLE "Bot" ADD COLUMN "projectId" TEXT REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Bot_projectId_idx" ON "Bot"("projectId");
