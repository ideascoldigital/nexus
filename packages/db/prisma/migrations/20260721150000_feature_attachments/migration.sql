-- Feature attachments: files (designs, docs) attached to a feature card.
-- Same shape as SandboxTask.attachments; copied onto the task at dispatch.
ALTER TABLE "Feature" ADD COLUMN "attachments" JSONB;
