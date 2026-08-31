-- Dev-console attachments: files the user sent with a prompt.
-- [{ name, mime, size, path }] — `path` is the host-side staging location;
-- the runner pushes them into the sandbox before the agent runs.
ALTER TABLE "SandboxTask" ADD COLUMN "attachments" JSONB;
