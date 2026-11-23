-- Bots (spec 23): AI teammates that each get an ephemeral desktop container
-- per session. A Bot is the persona and its job; a BotSession is one lifetime
-- of its computer (one container, deleted at the end); a BotRun is one prompt.

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "instructions" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '#8b5cf6',
    "model" TEXT,
    "claudeCredentialId" TEXT,
    "idleMinutes" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BotSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "containerName" TEXT NOT NULL,
    "vncPort" INTEGER,
    "vncPassword" TEXT,
    "claudeSessionId" TEXT,
    "error" TEXT,
    "lastActivityAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" DATETIME,
    CONSTRAINT "BotSession_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "log" TEXT NOT NULL DEFAULT '',
    "result" TEXT,
    "needsInput" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "costUsd" REAL,
    "durationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "BotRun_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BotRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "BotSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BotSession_botId_idx" ON "BotSession"("botId");

-- CreateIndex
CREATE INDEX "BotSession_status_idx" ON "BotSession"("status");

-- CreateIndex
CREATE INDEX "BotRun_botId_idx" ON "BotRun"("botId");

-- CreateIndex
CREATE INDEX "BotRun_sessionId_idx" ON "BotRun"("sessionId");
