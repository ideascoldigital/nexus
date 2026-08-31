-- Per-project Slack channel override for notifications (null = the global
-- Settings: slack_channel_id). Mirrors telegramChatId.
ALTER TABLE "SandboxConfig" ADD COLUMN "slackChannelId" TEXT;
