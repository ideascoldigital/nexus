-- Per-project cap on a single agent run. NULL = the 45-minute default; a
-- library upgrade running e2e suites legitimately needs more.
ALTER TABLE "SandboxConfig" ADD COLUMN "taskTimeoutMinutes" INTEGER;
