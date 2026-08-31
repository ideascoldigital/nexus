-- AlterTable: cloud provider for sandbox instances (civo | aws)
ALTER TABLE "SandboxConfig" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'civo';
