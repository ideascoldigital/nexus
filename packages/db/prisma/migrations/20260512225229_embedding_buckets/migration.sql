-- DropIndex
DROP INDEX IF EXISTS "EmbeddingIndex_projectId_sourceType_sourceId_key";

-- Recreate table with new columns (SQLite cannot add unique constraint cleanly)
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_EmbeddingIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL DEFAULT 'project-data',
    "indexKey" TEXT NOT NULL DEFAULT '',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Existing rows: assume project-data bucket with projectId-derived indexKey (substring(0,8)).
INSERT INTO "new_EmbeddingIndex" ("id","projectId","bucket","indexKey","sourceType","sourceId","contentHash","chunkCount","provider","dimensions","indexedAt")
SELECT "id","projectId",'project-data',substr("projectId",1,8),"sourceType","sourceId","contentHash","chunkCount","provider","dimensions","indexedAt"
FROM "EmbeddingIndex";

DROP TABLE "EmbeddingIndex";
ALTER TABLE "new_EmbeddingIndex" RENAME TO "EmbeddingIndex";

CREATE UNIQUE INDEX "EmbeddingIndex_bucket_indexKey_sourceType_sourceId_key" ON "EmbeddingIndex"("bucket","indexKey","sourceType","sourceId");
CREATE INDEX "EmbeddingIndex_projectId_idx" ON "EmbeddingIndex"("projectId");
CREATE INDEX "EmbeddingIndex_bucket_indexKey_idx" ON "EmbeddingIndex"("bucket","indexKey");

PRAGMA foreign_keys=ON;
