-- The sandbox's tailnet address, distinct from its cloud public IP (Tailscale
-- hands out 100.64.0.0/10; the provider's IP is whatever it is). Read from the
-- instance by the health probe once tailscale is up, so the UI can show both.
ALTER TABLE "Sandbox" ADD COLUMN "tailscaleIp" TEXT;
