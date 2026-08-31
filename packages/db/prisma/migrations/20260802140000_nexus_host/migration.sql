-- A Nexus host: the 24/7 VM that runs Nexux itself (spec 19).
--
-- Deliberately NOT a `Sandbox` row, even though both are Terraform-provisioned
-- cloud instances. A sandbox belongs to a project, is frequently ephemeral, and
-- `GET /sandboxes` reconciles local ones by inspecting Docker containers on
-- this machine (D-24) — a host is none of those, and would be reported dead by
-- that reconciliation while also appearing in every project's Sandboxes tab.
--
-- `publicIp` is stored but is NOT how the dashboard is reached: nothing is
-- published on it (D-34). It exists so support questions like "did the VM even
-- come up?" are answerable, and for the SSH used to read bootstrap state.
-- `tailscaleIp` is the address the app actually binds and serves on.
--
-- `imageRef` records exactly what was pulled rather than what was configured:
-- the setting can change afterwards, and "which image is this box running"
-- must stay answerable.
CREATE TABLE "NexusHost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provider" TEXT NOT NULL DEFAULT 'civo',
    "credentialId" TEXT,
    "tailscaleCredentialId" TEXT,
    "region" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "diskImage" TEXT NOT NULL DEFAULT 'ubuntu-jammy',
    "instanceId" TEXT,
    "publicIp" TEXT,
    "tailscaleIp" TEXT,
    "tailscaleName" TEXT,
    "imageRef" TEXT NOT NULL,
    "pullEmbeddingModel" BOOLEAN NOT NULL DEFAULT true,
    "workDir" TEXT NOT NULL,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "destroyedAt" DATETIME,
    CONSTRAINT "NexusHost_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "CloudCredential" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NexusHost_tailscaleCredentialId_fkey" FOREIGN KEY ("tailscaleCredentialId") REFERENCES "CloudCredential" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- The list is ordered newest-first and filters out destroyed rows.
CREATE INDEX "NexusHost_status_idx" ON "NexusHost"("status");
