-- Bot routines (spec 23): recurring work a bot does on its own — wake its
-- computer on a cron schedule and run a standing prompt.

-- CreateTable
CREATE TABLE "BotRoutine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BotRoutine_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BotRoutine_botId_idx" ON "BotRoutine"("botId");

-- CreateIndex
CREATE INDEX "BotRoutine_enabled_nextRunAt_idx" ON "BotRoutine"("enabled", "nextRunAt");
