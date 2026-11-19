-- A bot reply can carry emails for the user to review (```mail blocks). What
-- the user did with each card — sent (and by which run) or discarded — keyed
-- by its index in the reply, as JSON.
ALTER TABLE "BotRun" ADD COLUMN "mailState" TEXT;
