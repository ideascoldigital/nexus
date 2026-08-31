-- AlterTable: Stack tab docker services provisioned into sandboxes at bootstrap
ALTER TABLE "SandboxConfig" ADD COLUMN "includeStackServices" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Sandbox" ADD COLUMN "stackServices" JSONB;
