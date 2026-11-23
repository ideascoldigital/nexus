-- The vault (spec 32): logins, secrets, cards and contact details bots can use
-- without reading them. `secret` holds sealed JSON (AES-256-GCM; the key lives
-- outside the database).
CREATE TABLE "VaultItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "websites" JSONB,
    "username" TEXT,
    "label" TEXT,
    "hint" TEXT,
    "secret" JSONB NOT NULL,
    "botIds" JSONB,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "VaultItem_type_name_key" ON "VaultItem"("type", "name");
