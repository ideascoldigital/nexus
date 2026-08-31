-- CreateTable: saved, named provider credentials for sandboxes
CREATE TABLE "CloudCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "CloudCredential_provider_idx" ON "CloudCredential"("provider");

-- AlterTable: which saved credential a project launches with / a sandbox was provisioned with
ALTER TABLE "SandboxConfig" ADD COLUMN "credentialId" TEXT REFERENCES "CloudCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Sandbox" ADD COLUMN "credentialId" TEXT REFERENCES "CloudCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
