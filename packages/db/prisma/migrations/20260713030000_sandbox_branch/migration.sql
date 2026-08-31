-- AlterTable: configurable base branch for sandbox clones, task branches and PRs
ALTER TABLE "SandboxConfig" ADD COLUMN "branch" TEXT;
