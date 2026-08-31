-- AlterTable: agent policy on SandboxConfig
ALTER TABLE "SandboxConfig" ADD COLUMN "agentInstructions" TEXT;
ALTER TABLE "SandboxConfig" ADD COLUMN "createPr" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SandboxConfig" ADD COLUMN "runTests" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SandboxConfig" ADD COLUMN "captureScreenshots" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: task progress + PR result
ALTER TABLE "SandboxTask" ADD COLUMN "phase" TEXT;
ALTER TABLE "SandboxTask" ADD COLUMN "branch" TEXT;
ALTER TABLE "SandboxTask" ADD COLUMN "prUrl" TEXT;
