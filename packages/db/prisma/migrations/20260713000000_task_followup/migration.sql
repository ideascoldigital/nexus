-- AlterTable: session continuity for follow-up tasks
ALTER TABLE "SandboxTask" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "SandboxTask" ADD COLUMN "followUpOf" TEXT;
