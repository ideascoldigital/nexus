-- Per-project Claude model for agent runs, and sandbox archiving:
-- "remove from list" used to DELETE the Sandbox row, cascading away its
-- SandboxTask history (and the PR links with it). Archived rows stay.
ALTER TABLE "SandboxConfig" ADD COLUMN "claudeModel" TEXT;
ALTER TABLE "Sandbox" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
