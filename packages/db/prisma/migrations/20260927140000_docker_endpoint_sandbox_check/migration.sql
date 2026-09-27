-- DockerEndpoint.sandboxCheck: whether a sandbox would work on this daemon
-- (spec 28 phase 5) — the probe only says the daemon answers.
ALTER TABLE "DockerEndpoint" ADD COLUMN "sandboxCheck" JSONB;
