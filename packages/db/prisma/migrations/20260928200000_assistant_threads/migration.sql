-- Global assistant (spec 30): threads, their transcript, pending write
-- actions and watches.
CREATE TABLE "AssistantThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT,
    "projectId" TEXT,
    "scopes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "AssistantThread_workspaceId_idx" ON "AssistantThread"("workspaceId");

CREATE TABLE "AssistantEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AssistantThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AssistantEvent_threadId_createdAt_idx" ON "AssistantEvent"("threadId", "createdAt");

CREATE TABLE "AssistantAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    CONSTRAINT "AssistantAction_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AssistantThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AssistantAction_threadId_status_idx" ON "AssistantAction"("threadId", "status");

CREATE TABLE "AssistantWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "until" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantWatch_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "AssistantThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AssistantWatch_status_kind_targetId_idx" ON "AssistantWatch"("status", "kind", "targetId");
