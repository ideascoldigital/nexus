-- Dedicated dev sandboxes: chat-style prompt queue, continuous Claude
-- session, no PR pipeline, mutable Telegram notifications.
ALTER TABLE "Sandbox" ADD COLUMN "dedicated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Sandbox" ADD COLUMN "muteTelegram" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Sandbox" ADD COLUMN "devSessionId" TEXT;
ALTER TABLE "SandboxTask" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'task';
