-- OpenCode as a second delegable brain (spec 16): per-project brain selector,
-- OpenCode model, install toggle, and the N:M join that picks which saved LLM
-- provider API keys (CloudCredential) get injected into the sandbox env.
ALTER TABLE "SandboxConfig" ADD COLUMN "brain" TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE "SandboxConfig" ADD COLUMN "openCodeModel" TEXT;
ALTER TABLE "SandboxConfig" ADD COLUMN "installOpenCode" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SandboxConfigLlmCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "configId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    CONSTRAINT "SandboxConfigLlmCredential_configId_fkey" FOREIGN KEY ("configId") REFERENCES "SandboxConfig" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SandboxConfigLlmCredential_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "CloudCredential" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SandboxConfigLlmCredential_configId_credentialId_key" ON "SandboxConfigLlmCredential"("configId", "credentialId");
CREATE INDEX "SandboxConfigLlmCredential_configId_idx" ON "SandboxConfigLlmCredential"("configId");
