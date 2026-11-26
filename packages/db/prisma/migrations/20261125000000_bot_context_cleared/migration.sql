-- Clearing a conversation's context (spec 37). The bot's memory lives in its
-- container, so Nexus cannot reach into it: what it can do is stop resuming
-- the Claude session and stop replaying the earlier chat. This column is the
-- line it stops at — on the Bot, not the session, so a clear while the
-- computer is asleep still holds for the next one.
ALTER TABLE "Bot" ADD COLUMN "contextClearedAt" DATETIME;
