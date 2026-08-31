-- Slack gets its own per-sandbox mute, split from muteTelegram: the dev
-- console's bell used to silence both mediums with one flag.
ALTER TABLE "Sandbox" ADD COLUMN "muteSlack" BOOLEAN NOT NULL DEFAULT false;
