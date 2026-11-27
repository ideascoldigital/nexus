-- Spec 39: the reasoning effort a bot runs at (claude --effort); null = the CLI default.
ALTER TABLE "Bot" ADD COLUMN "effort" TEXT;
