-- NexusHost.dockerEndpointId: a host whose stack runs on a Docker endpoint
-- (spec 27, provider "docker-endpoint"). RESTRICT: removing the endpoint
-- would leave a host that can be neither updated nor destroyed.
ALTER TABLE "NexusHost" ADD COLUMN "dockerEndpointId" TEXT REFERENCES "DockerEndpoint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
