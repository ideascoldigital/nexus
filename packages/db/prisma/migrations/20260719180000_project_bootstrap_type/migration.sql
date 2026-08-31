-- Bootstrap projects: which template the project was bootstrapped from
-- (frontend | backend | fullstack | scripting | data-ai | research | mobile | library).
-- Null for projects created from existing repositories.
ALTER TABLE "Project" ADD COLUMN "bootstrapType" TEXT;
