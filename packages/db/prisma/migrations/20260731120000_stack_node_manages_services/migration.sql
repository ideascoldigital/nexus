-- Marks a local node whose command only launches background work (containers,
-- a daemon) and then exits. Liveness comes from what it started, not from the
-- spawned process, and teardown goes through stopCommand.
ALTER TABLE "StackNode" ADD COLUMN "managesServices" BOOLEAN NOT NULL DEFAULT false;

-- A local node that already needed a custom teardown is a launcher by
-- definition — carry that forward so behaviour does not regress.
UPDATE "StackNode"
SET "managesServices" = true
WHERE "runMode" = 'local' AND "stopCommand" IS NOT NULL AND trim("stopCommand") <> '';
