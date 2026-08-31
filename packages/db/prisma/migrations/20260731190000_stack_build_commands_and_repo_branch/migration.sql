-- Install/build commands on the stack node: the canvas already owns how a repo
-- runs, so it should own how it installs and builds too — sandboxes inherit
-- all three instead of re-guessing them.
ALTER TABLE "StackNode" ADD COLUMN "installCommand" TEXT;
ALTER TABLE "StackNode" ADD COLUMN "buildCommand" TEXT;

-- Per-repo branch override. Repos in one project can live on different
-- branches; null keeps the old behaviour (project-wide base branch).
ALTER TABLE "RepositorySetup" ADD COLUMN "branch" TEXT;

-- Seed the stack from whatever the sandbox already had configured, so the
-- canvas starts out agreeing with the sandbox rather than blank.
UPDATE "StackNode"
SET
  "installCommand" = (
    SELECT s."installCommand" FROM "RepositorySetup" s
    WHERE s."repositoryId" = "StackNode"."repositoryId"
  ),
  "buildCommand" = (
    SELECT s."buildCommand" FROM "RepositorySetup" s
    WHERE s."repositoryId" = "StackNode"."repositoryId"
  )
WHERE "runMode" = 'local' AND "repositoryId" IS NOT NULL;
