-- Optional Tailscale membership for sandboxes: when enabled, the bootstrap
-- installs tailscale and joins the tailnet with a saved auth-key credential
-- (the same "tailscale" credential kind Nexus hosts already use).
ALTER TABLE "SandboxConfig" ADD COLUMN "installTailscale" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SandboxConfig" ADD COLUMN "tailscaleCredentialId" TEXT;
