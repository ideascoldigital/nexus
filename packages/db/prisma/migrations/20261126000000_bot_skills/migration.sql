-- Skills a bot has loaded (spec 38): picked from the workspace's skill library
-- with /skills in its chat. Nexus writes each one into ~/.claude/skills in the
-- bot's computer before a prompt runs, where Claude Code finds it on its own.
CREATE TABLE "BotSkill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BotSkill_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BotSkill_botId_skillId_key" ON "BotSkill"("botId", "skillId");
CREATE INDEX "BotSkill_botId_idx" ON "BotSkill"("botId");
