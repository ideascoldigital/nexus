-- Connectors (spec 35): an app from the catalog, set up once and offered to
-- bots as an MCP server in their computer. The id is the catalog entry's
-- ("mongodb", "github", …), so each app is connected at most once. `config`
-- holds what the user typed — tokens included — and is sealed by the vault
-- extension like every other credential (spec 32).
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "config" JSONB NOT NULL,
    "botIds" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
