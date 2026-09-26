-- Sandbox.dockerHost: the daemon a local sandbox lives on (spec 26), copied
-- from its DockerEndpoint at launch so exec paths need no join. Null = this
-- machine, which is every sandbox that exists today.
ALTER TABLE "Sandbox" ADD COLUMN "dockerHost" TEXT;
