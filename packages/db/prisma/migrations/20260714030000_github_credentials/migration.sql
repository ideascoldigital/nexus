-- AlterTable: saved GitHub token per project, injected as GITHUB_TOKEN at launch
ALTER TABLE "SandboxConfig" ADD COLUMN "githubCredentialId" TEXT REFERENCES "CloudCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
