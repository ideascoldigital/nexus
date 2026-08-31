-- previewPort becomes nullable: null means "inherit from the Stack canvas".
-- Rows still holding the old default (3000) are indistinguishable from "never
-- configured", so they become null and start inheriting. Any other value was a
-- deliberate choice and is preserved as an override.
ALTER TABLE "SandboxConfig" RENAME COLUMN "previewPort" TO "previewPort_old";
ALTER TABLE "SandboxConfig" ADD COLUMN "previewPort" INTEGER;

UPDATE "SandboxConfig"
SET "previewPort" = CASE
  WHEN "previewPort_old" = 3000 THEN NULL
  ELSE "previewPort_old"
END;

ALTER TABLE "SandboxConfig" DROP COLUMN "previewPort_old";
