-- Bots belong to a workspace (D-87), like projects, agents, skills and
-- credentials before them: the bots view shows one workspace's team, and a
-- bot created there lands in it.
--
-- No REFERENCES clause, same as the original workspaces migration: SQLite only
-- accepts a foreign key on ADD COLUMN when the default is NULL, and the point
-- of 'ws-default' is that every bot that existed keeps working.
ALTER TABLE "Bot" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'ws-default';

CREATE INDEX "Bot_workspaceId_idx" ON "Bot"("workspaceId");
