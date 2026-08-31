-- Bearer tokens for the MCP control surface (spec 21) — the first inbound
-- programmatic path into Nexux, which until now had no auth layer at all.
--
-- Only the sha-256 hash is stored: the token is shown once at creation and is
-- unrecoverable afterwards, so a dashboard that leaks a screen cannot leak a
-- token issued earlier. `scopes` is a string[] carried as JSON, the same shape
-- every other list column here uses, since sqlite has no array type.
-- Revocation is a timestamp rather than a DELETE because the row is the record
-- that the token existed.

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_hash_key" ON "ApiToken"("hash");

-- CreateIndex
CREATE INDEX "ApiToken_revokedAt_idx" ON "ApiToken"("revokedAt");
