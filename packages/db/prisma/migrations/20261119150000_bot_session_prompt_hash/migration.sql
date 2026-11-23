-- Claude Code keeps a session's original system prompt on --resume, so a
-- bot whose instructions changed must start a fresh Claude session. The
-- hash of the system prompt the current Claude session started with.
ALTER TABLE "BotSession" ADD COLUMN "systemPromptHash" TEXT;
