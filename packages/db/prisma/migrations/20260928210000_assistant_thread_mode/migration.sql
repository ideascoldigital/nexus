-- The Stack tab's assistant becomes a thread of the global assistant (spec 30).
ALTER TABLE "AssistantThread" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'general';
CREATE INDEX "AssistantThread_projectId_mode_idx" ON "AssistantThread"("projectId", "mode");
