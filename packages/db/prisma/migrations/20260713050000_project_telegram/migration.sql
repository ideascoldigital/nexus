-- AlterTable: per-project Telegram chat (falls back to the global telegram_chat_id setting)
ALTER TABLE "SandboxConfig" ADD COLUMN "telegramChatId" TEXT;
