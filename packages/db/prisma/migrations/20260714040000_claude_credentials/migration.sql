-- AlterTable: saved Claude Code token per project, injected as CLAUDE_CODE_OAUTH_TOKEN at launch
ALTER TABLE "SandboxConfig" ADD COLUMN "claudeCredentialId" TEXT REFERENCES "CloudCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
