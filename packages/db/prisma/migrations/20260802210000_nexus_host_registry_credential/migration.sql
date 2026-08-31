-- Which git credential a host logs in to the image registry with.
--
-- GHCR takes a GitHub PAT (read:packages) as the docker password, so a private
-- package needs no separate registry secret. Until now the host used whichever
-- git credential was saved first, which silently picks the wrong account once
-- more than one exists — and a wrong token fails as `unauthorized` at pull
-- time, minutes into the bootstrap.
ALTER TABLE "NexusHost" ADD COLUMN "registryCredentialId" TEXT REFERENCES "CloudCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
