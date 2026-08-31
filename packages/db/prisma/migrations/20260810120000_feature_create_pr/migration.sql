-- Per-feature override of the project's "open a PR with the result" policy
-- (SandboxConfig.createPr). Nullable on purpose: NULL means "inherit the
-- project default", so existing features keep following the project setting
-- and only the ones explicitly marked pin their own behaviour.

-- AlterTable
ALTER TABLE "Feature" ADD COLUMN "createPr" BOOLEAN;
