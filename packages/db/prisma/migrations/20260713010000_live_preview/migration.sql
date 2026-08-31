-- AlterTable: cloudflare quick-tunnel live previews
ALTER TABLE "SandboxConfig" ADD COLUMN "installCloudflared" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SandboxConfig" ADD COLUMN "livePreview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SandboxConfig" ADD COLUMN "previewPort" INTEGER NOT NULL DEFAULT 3000;

-- AlterTable
ALTER TABLE "SandboxTask" ADD COLUMN "previewUrl" TEXT;
