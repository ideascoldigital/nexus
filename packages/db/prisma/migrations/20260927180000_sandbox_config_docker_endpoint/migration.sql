-- SandboxConfig.dockerEndpointId: which machine's Docker a project's local
-- sandboxes launch on (spec 26), saved with the rest of the config.
ALTER TABLE "SandboxConfig" ADD COLUMN "dockerEndpointId" TEXT REFERENCES "DockerEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
