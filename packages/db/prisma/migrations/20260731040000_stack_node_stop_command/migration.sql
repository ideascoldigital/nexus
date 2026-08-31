-- Optional teardown for local-mode nodes. Launcher commands (`make docker-up`,
-- `docker compose up -d`) leave background work behind that killing the spawned
-- process cannot stop; this runs on Down instead.
ALTER TABLE "StackNode" ADD COLUMN "stopCommand" TEXT;
