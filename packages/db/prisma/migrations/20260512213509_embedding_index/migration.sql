-- CreateTable
CREATE TABLE "EmbeddingIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingIndex_projectId_sourceType_sourceId_key" ON "EmbeddingIndex"("projectId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "EmbeddingIndex_projectId_idx" ON "EmbeddingIndex"("projectId");
